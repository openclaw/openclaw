import { normalizeApiKeyInput, validateApiKeyInput } from "../commands/auth-choice.api-key.js";
import { ensureApiKeyFromOptionEnvOrPrompt } from "../commands/auth-choice.apply-helpers.js";
import { buildApiKeyCredential } from "../commands/auth-credentials.js";
import { applyPrimaryModel } from "../commands/model-picker.js";
import { applyAuthProfileConfig } from "../commands/onboard-auth.js";

export {
  applyAuthProfileConfig,
  applyPrimaryModel,
  buildApiKeyCredential,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeApiKeyInput,
  validateApiKeyInput,
};
