import { resolveEnvApiKey } from "../agents/model-auth.js";
import { upsertSharedEnvVar } from "../infra/env-file.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";
import { createAuthChoiceAgentModelNoter } from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import { isRemoteEnvironment } from "./oauth-env.js";
import { applyAuthProfileConfig, writeOAuthCredentials } from "./onboard-auth.js";
import { openUrl } from "./onboard-helpers.js";
import {
  applyOpenAICodexModelDefault,
  OPENAI_CODEX_DEFAULT_MODEL,
} from "./openai-codex-model-default.js";
import { loginOpenAICodexOAuth } from "./openai-codex-oauth.js";
import {
  applyOpenAIConfig,
  applyOpenAIProviderConfig,
  OPENAI_DEFAULT_MODEL,
} from "./openai-model-default.js";

export async function applyAuthChoiceOpenAI(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  const noteAgentModel = createAuthChoiceAgentModelNoter(params);
  let authChoice = params.authChoice;
  if (authChoice === "apiKey" && params.opts?.tokenProvider === "openai") {
    authChoice = "openai-api-key";
  }

  if (authChoice === "openai-api-key") {
    let nextConfig = params.config;
    let agentModelOverride: string | undefined;

    const applyOpenAiDefaultModelChoice = async (): Promise<ApplyAuthChoiceResult> => {
      const applied = await applyDefaultModelChoice({
        config: nextConfig,
        setDefaultModel: params.setDefaultModel,
        defaultModel: OPENAI_DEFAULT_MODEL,
        applyDefaultConfig: applyOpenAIConfig,
        applyProviderConfig: applyOpenAIProviderConfig,
        noteDefault: OPENAI_DEFAULT_MODEL,
        noteAgentModel,
        prompter: params.prompter,
      });
      nextConfig = applied.config;
      agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
      return { config: nextConfig, agentModelOverride };
    };

    const envKey = resolveEnvApiKey("openai");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing OPENAI_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        const result = upsertSharedEnvVar({
          key: "OPENAI_API_KEY",
          value: envKey.apiKey,
        });
        if (!process.env.OPENAI_API_KEY) {
          process.env.OPENAI_API_KEY = envKey.apiKey;
        }
        await params.prompter.note(
          `Copied OPENAI_API_KEY to ${result.path} for launchd compatibility.`,
          "OpenAI API key",
        );
        return await applyOpenAiDefaultModelChoice();
      }
    }

    let key: string | undefined;
    if (params.opts?.token && params.opts?.tokenProvider === "openai") {
      key = params.opts.token;
    } else {
      key = await params.prompter.text({
        message: "Enter OpenAI API key",
        validate: validateApiKeyInput,
      });
    }

    const trimmed = normalizeApiKeyInput(String(key));
    const result = upsertSharedEnvVar({
      key: "OPENAI_API_KEY",
      value: trimmed,
    });
    process.env.OPENAI_API_KEY = trimmed;
    await params.prompter.note(
      `Saved OPENAI_API_KEY to ${result.path} for launchd compatibility.`,
      "OpenAI API key",
    );
    return await applyOpenAiDefaultModelChoice();
  }

  if (params.authChoice === "openai-codex") {
    let nextConfig = params.config;
    let agentModelOverride: string | undefined;

    let creds;
    try {
      creds = await loginOpenAICodexOAuth({
        prompter: params.prompter,
        runtime: params.runtime,
        isRemote: isRemoteEnvironment(),
        openUrl: async (url) => {
          await openUrl(url);
        },
        localBrowserMessage: "Complete sign-in in browser…",
      });
    } catch {
      // The helper already surfaces the error to the user.
      // Keep onboarding flow alive and return unchanged config.
      return { config: nextConfig, agentModelOverride };
    }
    if (creds) {
      await writeOAuthCredentials("openai-codex", creds, params.agentDir);
      nextConfig = applyAuthProfileConfig(nextConfig, {
        profileId: "openai-codex:default",
        provider: "openai-codex",
        mode: "oauth",
      });
      if (params.setDefaultModel) {
        const applied = applyOpenAICodexModelDefault(nextConfig);
        nextConfig = applied.next;
        if (applied.changed) {
          await params.prompter.note(
            `Default model set to ${OPENAI_CODEX_DEFAULT_MODEL}`,
            "Model configured",
          );
        }
      } else {
        agentModelOverride = OPENAI_CODEX_DEFAULT_MODEL;
        await noteAgentModel(OPENAI_CODEX_DEFAULT_MODEL);
      }
    }
    return { config: nextConfig, agentModelOverride };
  }

  return null;
}
