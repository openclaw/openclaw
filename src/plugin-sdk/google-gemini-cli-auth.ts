// Narrow plugin-sdk surface for the bundled google-gemini-cli-auth plugin.
// Keep this list additive and scoped to symbols used under extensions/google-gemini-cli-auth.

export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
export { hasProxyEnvConfigured } from "../infra/net/proxy-env.js";
export { isWSL2Sync } from "../infra/wsl.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { OpenClawPluginApi, ProviderAuthContext } from "../plugins/types.js";
export { buildOauthProviderAuthResult } from "./provider-auth-result.js";
