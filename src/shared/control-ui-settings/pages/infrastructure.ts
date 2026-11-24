import { defineSettingsPage } from "../define.js";

export const INFRASTRUCTURE_SETTINGS = defineSettingsPage({
  path: "/settings/infrastructure",
  title: "Infrastructure",
  settings: {
    "local.openLinksInControlUiBrowser": { label: "Open links in the built-in browser" },
  },
});
