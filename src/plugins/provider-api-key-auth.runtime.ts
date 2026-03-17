import { normalizeApiKeyInput, validateApiKeyInput } from "../commands/auth-choice.api-key.js";
import { ensureApiKeyFromOptionEnvOrPrompt } from "../commands/auth-choice.apply-helpers.js";
import { applyPrimaryModel } from "../commands/model-picker.js";
import { applyAuthProfileConfig, buildApiKeyCredential } from "./provider-auth-helpers.js";

export {
  applyAuthProfileConfig,
  applyPrimaryModel,
  buildApiKeyCredential,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeApiKeyInput,
  validateApiKeyInput,
};
