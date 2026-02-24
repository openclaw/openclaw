import { resolveEnvApiKey } from "../agents/model-auth.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";
import {
  normalizeSecretInputModeInput,
  resolveSecretInputModeForEnvSelection,
} from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyPrimaryModel } from "./model-picker.js";
import { applyAuthProfileConfig, setVolcengineApiKey } from "./onboard-auth.js";

/** Default model for Volcano Engine auth onboarding. */
export const VOLCENGINE_DEFAULT_MODEL = "volcengine-plan/ark-code-latest";

export async function applyAuthChoiceVolcengine(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "volcengine-api-key") {
    return null;
  }

  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
  const envKey = resolveEnvApiKey("volcengine");
  if (envKey) {
    const useExisting = await params.prompter.confirm({
      message: `Use existing VOLCANO_ENGINE_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
      initialValue: true,
    });
    if (useExisting) {
      const mode = await resolveSecretInputModeForEnvSelection({
        prompter: params.prompter,
        explicitMode: requestedSecretInputMode,
      });
      await setVolcengineApiKey(envKey.apiKey, params.agentDir, { secretInputMode: mode });
      const configWithAuth = applyAuthProfileConfig(params.config, {
        profileId: "volcengine:default",
        provider: "volcengine",
        mode: "api_key",
      });
      const configWithModel = applyPrimaryModel(configWithAuth, VOLCENGINE_DEFAULT_MODEL);
      return {
        config: configWithModel,
        agentModelOverride: VOLCENGINE_DEFAULT_MODEL,
      };
    }
  }

  let key: string | undefined;
  if (params.opts?.volcengineApiKey) {
    key = params.opts.volcengineApiKey;
  } else {
    key = await params.prompter.text({
      message: "Enter Volcano Engine API Key",
      validate: validateApiKeyInput,
    });
  }

  const trimmed = normalizeApiKeyInput(String(key));
  await setVolcengineApiKey(trimmed, params.agentDir, {
    secretInputMode: requestedSecretInputMode,
  });
  const configWithAuth = applyAuthProfileConfig(params.config, {
    profileId: "volcengine:default",
    provider: "volcengine",
    mode: "api_key",
  });
  const configWithModel = applyPrimaryModel(configWithAuth, VOLCENGINE_DEFAULT_MODEL);
  return {
    config: configWithModel,
    agentModelOverride: VOLCENGINE_DEFAULT_MODEL,
  };
}
