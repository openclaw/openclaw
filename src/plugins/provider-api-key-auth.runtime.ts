import { normalizeApiKeyInput, validateApiKeyInput } from "../commands/auth-choice.api-key.js";
import { ensureApiKeyFromOptionEnvOrPrompt } from "../commands/auth-choice.apply-helpers.js";
import { applyPrimaryModel } from "../commands/model-picker.js";
import { buildApiKeyCredential } from "../commands/onboard-auth.credentials.js";
import { applyAuthProfileConfig } from "../commands/onboard-auth.js";

export {
  applyAuthProfileConfig,
  applyPrimaryModel,
  buildApiKeyCredential,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeApiKeyInput,
  validateApiKeyInput,
};
