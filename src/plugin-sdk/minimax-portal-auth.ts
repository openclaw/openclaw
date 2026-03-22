// Narrow plugin-sdk surface for MiniMax OAuth helpers used by the bundled minimax plugin.
// Keep this list additive and scoped to MiniMax OAuth support code.

export { definePluginEntry } from "./core.js";
export { buildOauthProviderAuthResult } from "./provider-auth-result.js";
export type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderCatalogContext,
  ProviderAuthResult,
} from "../plugins/types.js";
export { generatePkceVerifierChallenge, toFormUrlEncoded } from "./oauth-utils.js";
