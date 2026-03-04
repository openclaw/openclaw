import {
  BAILIAN_PAYG_BASE_URL_CN,
  BAILIAN_PAYG_BASE_URL_INTL,
  BAILIAN_PAYG_BASE_URL_US,
  BAILIAN_CODING_BASE_URL_CN,
  BAILIAN_CODING_BASE_URL_INTL,
  BAILIAN_DEFAULT_MODEL_REF,
} from "../agents/bailian-models.js";
import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeSecretInputModeInput,
} from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyPrimaryModel } from "./model-picker.js";
import { applyAuthProfileConfig, setBailianApiKey } from "./onboard-auth.js";

export async function applyAuthChoiceBailian(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  const { authChoice, opts, config, prompter, agentDir } = params;

  if (!opts) {
    return null;
  }

  // Determine which auth choice we're handling
  let apiKeyOption: keyof typeof opts;
  let envLabel: string;
  let promptMessage: string;
  let baseUrl: string;

  if (authChoice === "bailian-payg-cn") {
    apiKeyOption = "bailianPaygCnApiKey" as keyof typeof opts;
    envLabel = "DASHSCOPE_API_KEY (Pay-as-you-go China)";
    promptMessage = "Enter Alibaba Cloud Bailian Pay-as-you-go (China) API key";
    baseUrl = BAILIAN_PAYG_BASE_URL_CN;
  } else if (authChoice === "bailian-payg-intl") {
    apiKeyOption = "bailianPaygIntlApiKey" as keyof typeof opts;
    envLabel = "DASHSCOPE_API_KEY (Pay-as-you-go International)";
    promptMessage = "Enter Alibaba Cloud Bailian Pay-as-you-go (International) API key";
    baseUrl = BAILIAN_PAYG_BASE_URL_INTL;
  } else if (authChoice === "bailian-payg-us") {
    apiKeyOption = "bailianPaygUsApiKey" as keyof typeof opts;
    envLabel = "DASHSCOPE_API_KEY (Pay-as-you-go US)";
    promptMessage = "Enter Alibaba Cloud Bailian Pay-as-you-go (US) API key";
    baseUrl = BAILIAN_PAYG_BASE_URL_US;
  } else if (authChoice === "bailian-coding-cn") {
    apiKeyOption = "bailianCodingCnApiKey" as keyof typeof opts;
    envLabel = "DASHSCOPE_API_KEY (Coding Plan China)";
    promptMessage = "Enter Alibaba Cloud Bailian Coding Plan (China) API key";
    baseUrl = BAILIAN_CODING_BASE_URL_CN;
  } else if (authChoice === "bailian-coding-intl") {
    apiKeyOption = "bailianCodingIntlApiKey" as keyof typeof opts;
    envLabel = "DASHSCOPE_API_KEY (Coding Plan International)";
    promptMessage = "Enter Alibaba Cloud Bailian Coding Plan (International) API key";
    baseUrl = BAILIAN_CODING_BASE_URL_INTL;
  } else {
    return null;
  }

  const requestedSecretInputMode = normalizeSecretInputModeInput(opts.secretInputMode);
  const apiKeyValue = opts[apiKeyOption] as string | undefined;

  await ensureApiKeyFromOptionEnvOrPrompt({
    token: apiKeyValue,
    tokenProvider: "bailian",
    secretInputMode: requestedSecretInputMode,
    config,
    expectedProviders: ["bailian"],
    provider: "bailian",
    envLabel,
    promptMessage,
    normalize: normalizeApiKeyInput,
    validate: validateApiKeyInput,
    prompter,
    setCredential: async (apiKey, mode) =>
      setBailianApiKey(apiKey, agentDir, { secretInputMode: mode, baseUrl }),
  });

  const configWithAuth = applyAuthProfileConfig(config, {
    profileId: "bailian:default",
    provider: "bailian",
    mode: "api_key",
  });

  const configWithModel = applyPrimaryModel(configWithAuth, BAILIAN_DEFAULT_MODEL_REF);

  return {
    config: configWithModel,
    agentModelOverride: BAILIAN_DEFAULT_MODEL_REF,
  };
}
