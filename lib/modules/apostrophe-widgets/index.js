// The base class for all modules that implement a widget, such as
// [apostrophe-rich-text-widgets](../apostrophe-rich-text-widgets/index.html),
// [apostrophe-pieces-widgets](../apostrophe-pieces-widgets/index.html) and
// [apostrophe-video-widgets](../apostrophe-video-widgets/index.html).
//
// All widgets have a [schema](../../tutorials/getting-started/schema-guide.html).
// Many project-specific modules that extend this module consist entirely of an
// `addFields` option and a `views/widget.html` file.
//
// For more information see the [custom widgets tutorial](../../tutorials/getting-started/custom-widgets.html).
//
// ## Options
//
// ### `label`
//
// The label of the widget, as seen in menus for adding widgets.
//
// ### `name`
//
// The unique name of this type of widget, as seen in the `type` property in the database.
// It will be singular if it displays one thing, like `apostrophe-video`,
// and plural if it displays more than one thing, like `apostrophe-pieces`.
// **By default, Apostrophe automatically removes `-widgets` from the name
// of your module to set this option for you.** This is a good convention
// but you may set this option instead if you wish.
//
// ### `scene`
//
// If your widget wishes to use Apostrophe features like schemas
// when interacting with *logged-out* users — for instance, to implement
// forms conveniently — you can set the `scene` option to `user`. Any
// page that contains the widget will then load the full javascript and stylesheet
// assets normally reserved for logged-in users. Note that if a page
// relies on AJAX calls to load more content later, the assets will not be
// upgraded. So you may wish to set the `scene` option of the appropriate
// subclass of `apostrophe-custom-pages` or `apostrophe-pieces-pages`, as well.
//
// ### `addFields`, `removeFields`, `arrangeFields`, etc.
//
// The standard options for building [schemas](../../tutorials/getting-started/schema-guide.html)
// are accepted. The widget will present a modal dialog box allowing the user to edit
// these fields. They are then available inside `widget.html` as properties of
// `data.widget`.
//
// ## Important templates
//
// You will need to supply a `views/widget.html` template for your module that
// extends this module.
//
// In `views/widget.html`, you can access any schema field as a property
// of `data.widget`. You can also access options passed to the widget as
// `data.options`.
//
// ## More
//
// If your widget requires JavaScript on the browser side, you will want
// to define the browser-side singleton that manages this type of widget by
// supplying a `public/js/always.js` file. In
// that file you will override the `play` method, which receives a jQuery element containing
// the appropriate div, the `data` for the widget, and the `options` that
// were passed to the widget.
//
// For example, here is the `public/js/always.js` file for the
// [apostrophe-video-widgets](../apostrophe-video-widgets/index.html) module:
//
//```javascript
// apos.define('apostrophe-video-widgets', {
//   extend: 'apostrophe-widgets',
//   construct: function(self, options) {
//     self.play = function($widget, data, options) {
//       return apos.oembed.queryAndPlay($widget.find('[data-apos-video-player]'), data.video);
//     };
//   }
// });
//```
//
// **ALWAYS USE `$widget.find`, NEVER $('selector....')` to create widget players.**
// Otherwise your site will suffer from "please click refresh after you save"
// syndrome. Otherwise known as "crappy site syndrome."
//
// ## Command line tasks
//
//```
//node app your-widget-module-name-here:list
//```
// Lists all of the places where this widget is used on the site. This is very useful if
// you are debugging a change and need to test all of the different ways a widget has
// been used, or are wondering if you can safely remove one.

var _ = require('lodash');
var async = require('async');

module.exports = {

  afterConstruct: function(self) {

    if (!self.options.label) {
      throw new Error('You must specify the label option when subclassing apostrophe-widgets');
    }
    self.label = self.options.label;
    self.name = self.options.name || self.__meta.name.replace(/\-widgets$/, '');
    self.apos.areas.setWidgetManager(self.name, self);

    self.apos.push.browserMirrorCall('user', self);
    self.apos.push.browserMirrorCall('user', self, { tool: 'editor' });

    self.apos.tasks.add(self.__meta.name, 'list',
      'Run this task to list all widgets of this type in the project.\n' +
      'Useful for testing.\n',
      self.list
    );

    self.pushAssets();
    self.pushDefineSingleton();
  },

  construct: function(self, options) {

    self.template = options.template || 'widget';
    self.schema = self.apos.schemas.compose(options);

    // Returns markup for the widget. Invoked by `widget.html` in the
    // `apostrophe-areas` module as it iterates over widgets in
    // an area. The default behavior is to render the template for the widget,
    // which is by default called `widget.html`, passing it `data.widget`
    // and `data.options`. The module is accessible as `data.manager`.

    self.output = function(widget, options) {
      var result = self.partial(self.template, { widget: widget, options: options, manager: self });
      return result;
    };

    // Perform joins and any other necessary async
    // actions for our type of widget. Note that
    // an array of widgets is handled in a single call
    // as you can usually optimize this.
    //
    // Override this to perform custom joins not
    // specified by your schema, talk to APIs, etc.
    //
    // Also implements the `scene` convenience option
    // for upgrading assets delivered to the browser
    // to the full set of `user` assets.

    self.load = function(req, widgets, callback) {
      if (self.options.scene) {
        req.scene = self.options.scene;
      }
      return async.series([ join, area ], callback);
      function join(callback) {
        return self.apos.schemas.join(req, self.schema, widgets, undefined, callback);
      }
      function area(callback) {

        // If this is a virtual widget (a widget being edited or previewed in the
        // editor), any nested areas, etc. inside it haven't already been loaded as
        // part of loading a doc. Do that now by creating a cursor and then feeding
        // it our widgets as if they were docs.

        if (!(widgets.length && widgets[0]._virtual)) {
          return setImmediate(callback);
        }

        // Get a doc cursor so that we can interpose the widgets as our docs and have the
        // normal things happen after the docs have been "loaded," such as calling loaders
        // of widgets in areas. -Tom and Matt

        // Shut off joins because we already did them and the cursor would try to do them
        // again based on `type`, which isn't really a doc type. -Tom
        var cursor = self.apos.docs.find(req).joins(false);

        // Call .after with our own results
        return cursor.after(widgets, callback);
      }
    };

    // Sanitize the widget. Invoked when the user has edited a widget on the
    // browser side. By default, the `input` object is sanitized via the
    // `convert` method of `apostrophe-schemas`, creating a new `output` object
    // so that no information in `input` is blindly trusted.
    //
    // The callback is invoked with `(null, output)`.
    self.sanitize = function(req, input, callback) {
      var output = {};
      output._id = self.apos.launder.id(input._id);
      return self.apos.schemas.convert(req, self.schema, 'form', input, output, function(err) {
        if (err) {
          return callback(err);
        }
        output.type = self.name;
        return callback(null, output);
      });
    };

    // Remove all properties of a widget that are the results of joins
    // (arrays or objects named with a leading `_`) for use in stuffing the
    // "data" attribute of the widget.
    //
    // If we don't do a good job here we get 1MB+ of markup! So if you override
    // this, play nice. And seriously consider using an AJAX route to fetch
    // the data you need if you only need it under certain circumstances, such as
    // in response to a user click.

    self.filterForDataAttribute = function(widget) {
      return self.apos.utils.clonePermanent(widget, true);
    };

    // Filter options passed from the template to the widget before stuffing
    // them into JSON for use by the widget editor. Again, we discard all
    // properties that are the results of joins or otherwise dynamic
    // (arrays or objects named with a leading `_`).
    //
    // If we don't do a good job here we get 1MB+ of markup. So if you override
    // this, play nice. And think about fetching the data you need only when
    // you truly need it, such as via an AJAX request in response to a click.

    self.filterOptionsForDataAttribute = function(options) {
      return self.apos.utils.clonePermanent(options, true);
    };

    // Push `always.js` to the browser at all times.
    // Push `user.js` to the browser when a user is logged in.
    // Push `editor.js` to the browser when a user is logged in.
    //
    // Note that if your module also has files by these names
    // they are automatically pushed too, and they will always
    // come after these, allowing you to `extend` properly
    // when calling `apos.define`.

    self.pushAssets = function() {
      self.pushAsset('script', 'always', { when: 'always' });
      self.pushAsset('script', 'user', { when: 'user' });
      self.pushAsset('script', 'editor', { when: 'user' });
    };

    // Define the browser-side singleton for this module, which exists
    // always in order to permit `play` methods.

    self.pushDefineSingleton = function() {
      self.apos.push.browserMirrorCall('always', self, { stop: 'apostrophe-widgets' });
    };

    // Before any page is sent to the browser, create the singleton.

    self.pageBeforeSend = function(req) {
      self.pushCreateSingleton(req, 'always');
    };

    // Set the options to be passed to the browser-side singleton corresponding
    // to this module. By default they do not depend on `req`, but the availability
    // of that parameter allows subclasses to make distinctions based on permissions,
    // etc.
    //
    // If a `browser` option was configured for the module its properties take precedence
    // over the default values passed on here for `name`, `label`, `action`
    // (the base URL of the module), `schema` and `contextualOnly`.

    self.getCreateSingletonOptions = function(req) {
      return _.defaults(options.browser || {}, {
          name: self.name,
          label: self.label,
          action: self.action,
          schema: self.schema,
          contextualOnly: self.options.contextualOnly
        }
      );
    };

    // Implement the command line task that lists all widgets of
    // this type found in the database:
    //
    // `node app your-module-name-here-widgets:list`

    self.list = function(apos, argv, callback) {

      return self.apos.migrations.eachWidget({}, iterator, callback);

      function iterator(doc, widget, dotPath, callback) {
        if (widget.type === self.name) {
          console.log(doc.slug + ':' + dotPath);
        }
        return setImmediate(callback);
      }

    };

    // A POST route to render `widgetEditor.html`. `data.label` and
    // `data.schema` are available to the template.

    self.route('post', 'modal', function(req, res) {
      // Make sure the chooser will be allowed to edit this schema
      self.apos.schemas.bless(req, self.schema);
      return res.send(self.render(req, 'widgetEditor.html', { label: self.label, schema: self.schema }));
    });
  }
};
