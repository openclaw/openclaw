/**
 * Public SDK subpath for API-key provider auth setup and secret input handling.
 */
export type { OpenClawConfig } from "../config/config.js";
export type { SecretInput } from "../config/types.secrets.js";

export {
  upsertAuthProfileWithLockCompat as upsertAuthProfileWithLock,
  upsertAuthProfileWithLockOrThrowCompat as upsertAuthProfileWithLockOrThrow,
} from "./provider-auth-write-compat.js";
export {
  normalizeApiKeyInput,
  validateApiKeyInput,
  ensureApiKeyFromOptionEnvOrPrompt,
} from "../plugins/provider-auth-input.js";
export {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  upsertApiKeyProfile,
} from "../plugins/provider-auth-helpers.js";
export {
  captureProviderApiKey,
  createProviderApiKeyAuthMethod,
  persistProviderApiKey,
} from "../plugins/provider-api-key-auth.js";
export { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
