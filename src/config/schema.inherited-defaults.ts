import { DEFAULT_PLUGINS_ENABLED } from "../plugins/default-enablement.js";
import { DEFAULT_CRON_ENABLED } from "./cron-limits.js";

// Display hints describe omitted authored values without materializing defaults.
export const INHERITED_DEFAULT_PLACEHOLDERS: Readonly<Record<string, string>> = {
  "cron.enabled": `Default: ${DEFAULT_CRON_ENABLED ? "On" : "Off"}`,
  "plugins.enabled": `Default: ${DEFAULT_PLUGINS_ENABLED ? "On" : "Off"}`,
};
