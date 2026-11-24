import { defineSettingsPage } from "../define.js";

export const SECURITY_SETTINGS = defineSettingsPage({
  path: "/settings/security",
  title: "Privacy & security",
  settings: {
    "securityPage.gatewayAuth": { label: "Gateway authentication" },
    "securityPage.networkAccess": { label: "Network access" },
    "securityPage.devices": { label: "Devices" },
    "securityPage.execPolicy": { label: "Gateway command defaults" },
    "tools.profile": { label: "Available tools" },
    "browser.enabled": { label: "Browser tools" },
    "securityPage.approvals": { label: "Approvals" },
  },
});
