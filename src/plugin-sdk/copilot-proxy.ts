// Narrow plugin-sdk surface for the bundled copilot-proxy plugin.
// Keep this list additive and scoped to the bundled Copilot proxy surface.

export { definePluginEntry } from "./plugin-entry.js";
export type {
  MullusiPluginApi,
  ProviderAuthContext,
  ProviderAuthResult,
} from "../plugins/types.js";
