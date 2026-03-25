// Narrow plugin-sdk surface for the bundled copilot-proxy plugin.
// Keep this list additive and scoped to symbols used under extensions/copilot-proxy.

export { definePluginEntry } from "./plugin-entry.js";
export type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderAuthResult,
} from "../plugins/types.js";
