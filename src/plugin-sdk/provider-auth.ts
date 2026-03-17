// Public auth/onboarding helpers for provider plugins.

export type { OpenClawConfig } from "../config/config.js";
export type { SecretInput } from "../config/types.secrets.js";
export type { ProviderAuthResult } from "../plugins/types.js";
export type { AuthProfileStore, OAuthCredential } from "../agents/auth-profiles/types.js";

export {
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
  ensureAuthProfileStore,
  listProfilesForProvider,
  suggestOAuthProfileIdForLegacyDefault,
  upsertAuthProfile,
} from "../agents/auth-profiles.js";
export {
  MINIMAX_OAUTH_MARKER,
  resolveNonEnvSecretRefApiKeyMarker,
} from "../agents/model-auth-markers.js";
export {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "../commands/auth-choice.api-key.js";
export {
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeSecretInputModeInput,
  promptSecretRefForSetup,
  resolveSecretInputModeForEnvSelection,
} from "../commands/auth-choice.apply-helpers.js";
export { buildTokenProfileId, validateAnthropicSetupToken } from "../commands/auth-token.js";
export { applyAuthProfileConfig, buildApiKeyCredential } from "../plugins/provider-auth-helpers.js";
export { githubCopilotLoginCommand } from "../providers/github-copilot-auth.js";
export { loginOpenAICodexOAuth } from "../commands/openai-codex-oauth.js";
export { createProviderApiKeyAuthMethod } from "../plugins/provider-api-key-auth.js";
export { coerceSecretRef } from "../config/types.secrets.js";
export { resolveDefaultSecretProviderAlias } from "../secrets/ref-contract.js";
export { resolveRequiredHomeDir } from "../infra/home-dir.js";
export {
  normalizeOptionalSecretInput,
  normalizeSecretInput,
} from "../utils/normalize-secret-input.js";
