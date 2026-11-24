import { defineSettingsPage } from "../define.js";

export const DEVICES_SETTINGS = defineSettingsPage({
  path: "/settings/devices",
  title: "Devices",
  settings: {
    "devices.gateway": { label: "Computer running OpenClaw" },
    "devices.device.*": { label: "Device" },
    "devices.execApprovals.host": { label: "Device" },
    "devices.execApprovals.defaults": { label: "Defaults" },
    "devices.execApprovals.defaults.*": {
      label: "Default policy",
      within: "devices.execApprovals.defaults",
    },
    "devices.execApprovals.defaults.autoAllowSkills": {
      label: "Auto-allow skill CLIs",
      within: "devices.execApprovals.defaults",
    },
    // An agent's own fields are named under its row, as in `devices.execApprovals.agents.main.ask`.
    "devices.execApprovals.agents.*": { label: "Agent policy" },
    "tools.exec.node": { label: "Default binding" },
    "devices.agentBinding.*": { label: "Binding" },
  },
});
