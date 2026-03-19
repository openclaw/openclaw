// Narrow plugin-sdk surface for the bundled phone-control plugin.
// Keep this list additive and scoped to symbols used under extensions/phone-control.

export { definePluginEntry } from "./core.js";
export type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  OpenClawPluginService,
  PluginCommandContext,
} from "../plugins/types.js";
