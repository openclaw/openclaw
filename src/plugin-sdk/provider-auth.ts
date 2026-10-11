// Provider auth helpers define auth methods, credential resolution, and setup status contracts.
import { resolveAuthProfileOrder } from "../agents/auth-profiles/order.js";
import { normalizeGithubCopilotDomain } from "./github-copilot-domain.js";

export { resolveNonEnvSecretRefApiKeyMarker } from "../secrets/provider-credential-values.js";
export type { OpenClawConfig } from "../config/config.js";
export type { SecretInput } from "../config/types.secrets.js";
export type { SecretInputMode } from "../plugins/provider-auth-types.js";
export type { ProviderAuthResult } from "../plugins/types.js";
export type { ProviderAuthContext } from "../plugins/types.js";
export type { AuthProfileStore, OAuthCredential } from "../agents/auth-profiles/types.js";

export { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
export { normalizeGithubCopilotDomain, resolveAuthProfileOrder };
export { CLAUDE_CLI_PROFILE_ID, CODEX_CLI_PROFILE_ID } from "../agents/auth-profiles/constants.js";
export {
  ensureAuthProfileStore,
  ensureAuthProfileStoreForLocalUpdate,
} from "../agents/auth-profiles/store-runtime.js";
export { listProfilesForProvider, upsertAuthProfile } from "../agents/auth-profiles/profiles.js";
export {
  removeProviderAuthProfilesWithLockCompat as removeProviderAuthProfilesWithLock,
  updateAuthProfileStoreWithLockCompat as updateAuthProfileStoreWithLock,
  upsertAuthProfileWithLockCompat as upsertAuthProfileWithLock,
} from "./provider-auth-write-compat.js";
export { resolveEnvApiKey } from "../agents/model-auth-env.js";
export { readCodexCliCredentialsCached } from "../agents/cli-credentials.js";
export { readClaudeCliCredentialsCached } from "./provider-auth-claude-compat.js";
export { suggestOAuthProfileIdForLegacyDefault } from "../agents/auth-profiles/repair.js";
export {
  CUSTOM_LOCAL_AUTH_MARKER,
  MINIMAX_OAUTH_MARKER,
  isKnownEnvApiKeyMarker,
  isNonSecretApiKeyMarker,
  resolveOAuthApiKeyMarker,
} from "../agents/model-auth-markers.js";
export {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "../plugins/provider-auth-input.js";
export {
  ensureApiKeyFromEnvOrPrompt,
  ensureApiKeyFromOptionEnvOrPrompt,
  promptSecretRefForSetup,
  resolveSecretInputModeForEnvSelection,
} from "../plugins/provider-auth-input.js";
export { normalizeApiKeyConfig } from "../agents/models-config.providers.secret-helpers.js";
export {
  buildTokenProfileId,
  validateAnthropicSetupToken,
} from "../plugins/provider-auth-token.js";
export {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  upsertApiKeyProfile,
  writeOAuthCredentials,
  type ApiKeyStorageOptions,
  type WriteOAuthCredentialsOptions,
} from "../plugins/provider-auth-helpers.js";
export { createProviderApiKeyAuthMethod } from "../plugins/provider-api-key-auth.js";
export { coerceSecretRef, hasConfiguredSecretInput } from "../config/types.secrets.js";
export { resolveDefaultSecretProviderAlias } from "./secret-provider-alias.js";
export { resolveRequiredHomeDir } from "../infra/home-dir.js";
export {
  normalizeOptionalSecretInput,
  normalizeSecretInput,
} from "../utils/normalize-secret-input.js";
export { listKnownProviderAuthEnvVarNames } from "./provider-env-vars.js";
export { omitEnvKeysCaseInsensitive } from "../secrets/provider-env-vars.js";
export { buildOauthProviderAuthResult } from "./provider-auth-result.js";
export {
  buildOpenAICodexCredentialExtra,
  decodeOpenAICodexJwtPayload,
  resolveOpenAICodexAccessTokenExpiry,
  resolveOpenAICodexAuthIdentity,
  resolveOpenAICodexImportProfileName,
  type OpenAICodexAuthIdentity,
} from "./provider-openai-chatgpt-auth.js";
export {
  generateHexPkceVerifierChallenge,
  generatePkceVerifierChallenge,
  toFormUrlEncoded,
} from "./oauth-utils.js";
export {
  DEFAULT_OAUTH_REFRESH_MARGIN_MS,
  hasUsableOAuthCredential,
} from "../agents/auth-profiles/credential-state.js";
export {
  COPILOT_EDITOR_PLUGIN_VERSION,
  COPILOT_EDITOR_VERSION,
  COPILOT_GITHUB_API_VERSION,
  COPILOT_INTEGRATION_ID,
  COPILOT_USER_AGENT,
  buildCopilotIdeHeaders,
} from "../agents/copilot-dynamic-headers.js";

export {
  isProviderApiKeyConfigured,
  isProviderAuthProfileConfigured,
  listUsableProviderAuthProfileIds,
  resolveProviderAuthProfileApiKey,
} from "../plugins/provider-auth-availability.js";
