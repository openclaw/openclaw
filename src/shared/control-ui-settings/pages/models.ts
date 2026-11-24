import { defineSettingsPage } from "../define.js";

export const MODELS_SETTINGS = defineSettingsPage({
  path: "/settings/model-providers",
  title: "Models",
  settings: {
    "agents.defaults.model.primary": { label: "Model" },
    "agents.defaults.thinkingDefault": { label: "Effort" },
    "agents.defaults.fastModeDefault": { label: "Speed" },
    "modelProviders.moreSettings": { label: "More settings" },
    "agents.defaults.model.fallbacks": {
      label: "Fallback model",
      within: "modelProviders.moreSettings",
    },
    "agents.defaults.utilityModel.primary": {
      label: "Utility model",
      within: "modelProviders.moreSettings",
    },
    "agents.defaults.utilityModel.fallbacks": {
      label: "Utility fallback model",
      within: "modelProviders.moreSettings",
    },
    "agents.defaults.decisionModel": {
      label: "Decision model",
      within: "modelProviders.moreSettings",
    },
    "providers.*": { label: "Provider" },
    // Each app's switch is plugins.entries.acpx.config.nativeAgents.<app>, a plugin's own config.
    "modelProviders.installedAgents.*": { label: "Installed agent" },
  },
});
