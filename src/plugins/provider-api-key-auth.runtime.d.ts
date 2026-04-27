import { applyAuthProfileConfig, buildApiKeyCredential } from "./provider-auth-helpers.js";
import { ensureApiKeyFromOptionEnvOrPrompt, normalizeApiKeyInput } from "./provider-auth-input.js";
import { applyPrimaryModel } from "./provider-model-primary.js";
export declare const providerApiKeyAuthRuntime: {
    applyAuthProfileConfig: typeof applyAuthProfileConfig;
    applyPrimaryModel: typeof applyPrimaryModel;
    buildApiKeyCredential: typeof buildApiKeyCredential;
    ensureApiKeyFromOptionEnvOrPrompt: typeof ensureApiKeyFromOptionEnvOrPrompt;
    normalizeApiKeyInput: typeof normalizeApiKeyInput;
    validateApiKeyInput: (value: string) => "Required" | undefined;
};
