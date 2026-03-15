// Narrow plugin-sdk surface for the bundled minimax-portal-auth plugin.
// Keep this list additive and scoped to symbols used under extensions/minimax-portal-auth.

export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export { buildOauthProviderAuthResult } from "./provider-auth-result.js";
export type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderCatalogContext,
  ProviderAuthResult,
} from "../plugins/types.js";
export { generatePkceVerifierChallenge, toFormUrlEncoded } from "./oauth-utils.js";
