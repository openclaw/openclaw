import { defineSettingsPage } from "../define.js";

export const MCP_SETTINGS = defineSettingsPage({
  path: "/settings/mcp",
  title: "MCP",
  settings: {
    "mcp.apps.enabled": { label: "MCP Apps" },
    "mcpPage.operatorCommands": { label: "Command line" },
  },
});
