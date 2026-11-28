import { defineSettingsPage } from "../define.js";

export const CONNECTION_SETTINGS = defineSettingsPage({
  path: "/settings/connection",
  title: "Gateway",
  settings: {
    "local.gatewayUrl": { label: "Gateway URL" },
    "local.token": { label: "Gateway secret" },
    "local.sessionKey": { label: "Default session" },
    "connection.forgetDevice": { label: "Saved sign-in for this Gateway" },
  },
});
