// Narrow plugin-sdk surface for the bundled qwen-portal-auth plugin.
// Keep this list additive and scoped to symbols used under extensions/qwen-portal-auth.

export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export { buildOauthProviderAuthResult } from "./provider-auth-result.js";
export type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderCatalogContext,
} from "../plugins/types.js";
export { ensureAuthProfileStore, listProfilesForProvider } from "../agents/auth-profiles.js";
export { QWEN_OAUTH_MARKER } from "../agents/model-auth-markers.js";
export { refreshQwenPortalCredentials } from "../providers/qwen-portal-oauth.js";
export { generatePkceVerifierChallenge, toFormUrlEncoded } from "./oauth-utils.js";
