import { defineSettingsPage } from "../define.js";

export const SECRETS_SETTINGS = defineSettingsPage({
  path: "/settings/secrets",
  title: "Secrets",
  settings: {
    "secretsPage.entries.*": { label: "Secrets" },
  },
});
