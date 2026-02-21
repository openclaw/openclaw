import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import { upsertSharedEnvVar } from "../infra/env-file.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";
import { applyPrimaryModel } from "./model-picker.js";

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
      const result = upsertSharedEnvVar({
        key: "BYTEPLUS_API_KEY",
        value: envKey.apiKey,
      });
      if (!process.env.BYTEPLUS_API_KEY) {
        process.env.BYTEPLUS_API_KEY = envKey.apiKey;
      }
      await params.prompter.note(
        `Copied BYTEPLUS_API_KEY to ${result.path} for launchd compatibility.`,
        "BytePlus API key",
      );
      const configWithModel = applyPrimaryModel(params.config, BYTEPLUS_DEFAULT_MODEL);
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
  const result = upsertSharedEnvVar({
    key: "BYTEPLUS_API_KEY",
    value: trimmed,
  });
  process.env.BYTEPLUS_API_KEY = trimmed;
  await params.prompter.note(
    `Saved BYTEPLUS_API_KEY to ${result.path} for launchd compatibility.`,
    "BytePlus API key",
  );

  const configWithModel = applyPrimaryModel(params.config, BYTEPLUS_DEFAULT_MODEL);
  return {
    config: configWithModel,
    agentModelOverride: BYTEPLUS_DEFAULT_MODEL,
  };
}
