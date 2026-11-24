import { defineSettingsPage } from "../define.js";

export const PLUGINS_SETTINGS = defineSettingsPage({
  path: "/settings/plugins",
  title: "Plugins",
  settings: {
    "plugins.entries.*": { label: "Plugins" },
    // Drawn on one plugin's settings, below this path.
    "pluginSettings.connectProvider": { label: "Models" },
  },
});
