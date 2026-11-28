/** Settings rows, including editors with their own layout. Arrival, the ID check and the browser audit agree on what counts as a row. */
export const SETTINGS_ROW_CLASSES = [
  "settings-row",
  "provider-row",
  "mcp-server-row__head",
  "agent-tool-summary",
  "device-allowlist",
  "device-token",
  "model-providers__profiles",
  "model-providers__profile",
];
export const SETTINGS_ROW_SELECTOR = SETTINGS_ROW_CLASSES.map((name) => `.${name}`).join(", ");
