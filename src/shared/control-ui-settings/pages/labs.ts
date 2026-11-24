import { defineSettingsPage } from "../define.js";

export const LABS_SETTINGS = defineSettingsPage({
  path: "/settings/labs",
  title: "Labs",
  settings: {
    "agents.defaults.experimental.decisionAssistance": { label: "Decision assistance" },
    "agents.defaults.experimental.usageRankedToolIndex": { label: "Usage-ranked tool index" },
    "gateway.controlUi.experimental.composerPredictions.enabled": {
      label: "Composer predictions",
    },
    "gateway.controlUi.experimental.composerPredictions.model": { label: "Prediction model" },
    "gateway.controlUi.experimental.chatBubbles": { label: "Speech bubbles" },
    "desktop.host.enabled": { label: "Desktop on the computer running OpenClaw" },
    "gateway.openclawId.enabled": { label: "OpenClaw ID remote access" },
    "cloudWorkers.desktop": { label: "Cloud device desktop" },
  },
});
