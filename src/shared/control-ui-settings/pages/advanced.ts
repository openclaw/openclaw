import { defineSettingsPage } from "../define.js";

export const ADVANCED_SETTINGS = defineSettingsPage({
  path: "/settings/advanced",
  title: "Advanced",
  settings: {
    "advanced.setupWizard": { label: "Setup" },
    "advanced.rawConfig": { label: "Raw config (JSON/JSON5)" },
  },
});
