import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import { upsertSharedEnvVar } from "../infra/env-file.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";
import { applyPrimaryModel } from "./model-picker.js";

/** Default model for Volcano Engine auth onboarding. */
export const VOLCENGINE_DEFAULT_MODEL = "volcengine-plan/ark-code-latest";

export async function applyAuthChoiceVolcengine(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "volcengine-api-key") {
    return null;
  }

  const envKey = resolveEnvApiKey("volcengine");
  if (envKey) {
    const useExisting = await params.prompter.confirm({
      message: `Use existing VOLCANO_ENGINE_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
      initialValue: true,
    });
    if (useExisting) {
      const result = upsertSharedEnvVar({
        key: "VOLCANO_ENGINE_API_KEY",
        value: envKey.apiKey,
      });
      if (!process.env.VOLCANO_ENGINE_API_KEY) {
        process.env.VOLCANO_ENGINE_API_KEY = envKey.apiKey;
      }
      await params.prompter.note(
        `Copied VOLCANO_ENGINE_API_KEY to ${result.path} for launchd compatibility.`,
        "Volcano Engine API Key",
      );
      const configWithModel = applyPrimaryModel(params.config, VOLCENGINE_DEFAULT_MODEL);
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
  const result = upsertSharedEnvVar({
    key: "VOLCANO_ENGINE_API_KEY",
    value: trimmed,
  });
  process.env.VOLCANO_ENGINE_API_KEY = trimmed;
  await params.prompter.note(
    `Saved VOLCANO_ENGINE_API_KEY to ${result.path} for launchd compatibility.`,
    "Volcano Engine API Key",
  );

  const configWithModel = applyPrimaryModel(params.config, VOLCENGINE_DEFAULT_MODEL);
  return {
    config: configWithModel,
    agentModelOverride: VOLCENGINE_DEFAULT_MODEL,
  };
}
