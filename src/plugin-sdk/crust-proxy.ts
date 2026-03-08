// Narrow plugin-sdk surface for the bundled crust-proxy plugin.
// Keep this list additive and scoped to symbols used under extensions/crust-proxy.

export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderAuthResult,
} from "../plugins/types.js";
