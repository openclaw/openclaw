import { resolveEnvApiKey } from "../agents/model-auth.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyPrimaryModel } from "./model-picker.js";
import { applyAuthProfileConfig, setByteplusApiKey } from "./onboard-auth.js";

/** Default model for BytePlus auth onboarding. */
export const BYTEPLUS_DEFAULT_MODEL = "byteplus-plan/ark-code-latest";

export async function applyAuthChoiceBytePlus(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "byteplus-api-key") {
    return null;
  }

  const envKey = resolveEnvApiKey("byteplus");
  if (envKey) {
    const useExisting = await params.prompter.confirm({
      message: `Use existing BYTEPLUS_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
      initialValue: true,
    });
    if (useExisting) {
      await setByteplusApiKey(envKey.apiKey, params.agentDir);
      const configWithAuth = applyAuthProfileConfig(params.config, {
        profileId: "byteplus:default",
        provider: "byteplus",
        mode: "api_key",
      });
      const configWithModel = applyPrimaryModel(configWithAuth, BYTEPLUS_DEFAULT_MODEL);
      return {
        config: configWithModel,
        agentModelOverride: BYTEPLUS_DEFAULT_MODEL,
      };
    }
  }

  let key: string | undefined;
  if (params.opts?.byteplusApiKey) {
    key = params.opts.byteplusApiKey;
  } else {
    key = await params.prompter.text({
      message: "Enter BytePlus API key",
      validate: validateApiKeyInput,
    });
  }

  const trimmed = normalizeApiKeyInput(String(key));
  await setByteplusApiKey(trimmed, params.agentDir);
  const configWithAuth = applyAuthProfileConfig(params.config, {
    profileId: "byteplus:default",
    provider: "byteplus",
    mode: "api_key",
  });
  const configWithModel = applyPrimaryModel(configWithAuth, BYTEPLUS_DEFAULT_MODEL);
  return {
    config: configWithModel,
    agentModelOverride: BYTEPLUS_DEFAULT_MODEL,
  };
}
