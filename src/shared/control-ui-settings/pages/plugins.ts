import { defineSettingsPage } from "../define.js";

export const PLUGINS_SETTINGS = defineSettingsPage({
  path: "/settings/plugins",
  title: "Plugins",
  settings: {
    "plugins.entries.*": { label: "Plugins" },
  },
});
