import { defineSettingsPage } from "../define.js";

export const ADVANCED_SETTINGS = defineSettingsPage({
  path: "/settings/advanced",
  title: "Advanced",
  settings: {
    "advanced.setupWizard": { label: "Setup", section: "wizard" },
  },
});
