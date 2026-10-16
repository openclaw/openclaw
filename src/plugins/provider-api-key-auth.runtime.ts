// Runtime bridge for provider API-key auth configured by plugins.
export { upsertAuthProfileWithLockOrThrow } from "../agents/auth-profiles/profiles.js";
export { applyAuthProfileConfig, buildApiKeyCredential } from "./provider-auth-helpers.js";
export {
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./provider-auth-input.js";
export { applyPrimaryModel } from "./provider-model-primary.js";
