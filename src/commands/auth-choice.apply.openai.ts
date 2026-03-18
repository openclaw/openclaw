import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  createAuthChoiceAgentModelNoter,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeSecretInputModeInput,
} from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import { isRemoteEnvironment } from "./oauth-env.js";
import { applyAuthProfileConfig, setOpenaiApiKey, writeOAuthCredentials } from "./onboard-auth.js";
import { openUrl } from "./onboard-helpers.js";
import { loginOpenAICodexDeviceCode } from "./openai-codex-device-code.js";
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
  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
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

    await ensureApiKeyFromOptionEnvOrPrompt({
      token: params.opts?.token,
      tokenProvider: params.opts?.tokenProvider,
      secretInputMode: requestedSecretInputMode,
      config: nextConfig,
      expectedProviders: ["openai"],
      provider: "openai",
      envLabel: "OPENAI_API_KEY",
      promptMessage: "Enter OpenAI API key",
      normalize: normalizeApiKeyInput,
      validate: validateApiKeyInput,
      prompter: params.prompter,
      setCredential: async (apiKey, mode) =>
        setOpenaiApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
    });
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "openai:default",
      provider: "openai",
      mode: "api_key",
    });
    return await applyOpenAiDefaultModelChoice();
  }

  const isOpenAICodexCliChoice =
    params.authChoice === "openai-codex-cli" || params.authChoice === "openai-device-code";

  if (params.authChoice === "openai-codex" || isOpenAICodexCliChoice) {
    let nextConfig = params.config;
    let agentModelOverride: string | undefined;
    let creds: OAuthCredentials | null = null;

    const persistCodexCredentials = async (creds: OAuthCredentials | null) => {
      if (!creds) {
        return;
      }

      const profileId = await writeOAuthCredentials("openai-codex", creds, params.agentDir, {
        syncSiblingAgents: true,
      });
      nextConfig = applyAuthProfileConfig(nextConfig, {
        profileId,
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
    };

    if (isOpenAICodexCliChoice) {
      await params.prompter.note(
        [
          "Starting Codex CLI login.",
          "Complete the Codex CLI sign-in flow shown in this terminal.",
        ].join("\n"),
        "OpenAI Codex CLI",
      );
      creds = await loginOpenAICodexDeviceCode();
      if (!creds) {
        throw new Error("Codex CLI login did not return credentials.");
      }
    } else {
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
        return { config: nextConfig, agentModelOverride };
      }
    }
    await persistCodexCredentials(creds);
    return { config: nextConfig, agentModelOverride };
  }

  return null;
}
