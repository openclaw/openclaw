import { ensureAuthProfileStore, listProfilesForProvider } from "../agents/auth-profiles.js";
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
      let derivedEmail =
        typeof creds?.email === "string" && creds.email.trim() ? creds.email.trim() : "";
      if (!derivedEmail && typeof creds?.access === "string") {
        try {
          const tokenParts = creds.access.split(".");
          if (tokenParts.length >= 2) {
            const payload = JSON.parse(Buffer.from(tokenParts[1], "base64url").toString("utf8"));
            derivedEmail =
              payload?.["https://api.openai.com/profile"]?.email || payload?.email || "";
          }
        } catch {
          // best-effort email extraction for picker labels
        }
      }

      const emailSuffix = derivedEmail || "default";
      const defaultProfileId = "openai-codex:default";
      const emailProfileId = `openai-codex:${emailSuffix}`;
      const store = ensureAuthProfileStore(params.agentDir);
      const existingProfileIds = listProfilesForProvider(store, "openai-codex");
      let altIndex = 1;
      while (existingProfileIds.includes(`openai-codex:alt${altIndex}`)) {
        altIndex += 1;
      }
      const altProfileId = `openai-codex:alt${altIndex}`;

      let requestedProfileId = params.opts?.profileId ? String(params.opts.profileId).trim() : "";
      const hasDefaultProfile = existingProfileIds.includes(defaultProfileId);
      if (!requestedProfileId) {
        if (!hasDefaultProfile) {
          requestedProfileId = defaultProfileId;
        } else {
          const choice = String(
            await params.prompter.select({
              message: "Profile id",
              options: [
                {
                  value: emailProfileId,
                  label: `email (${emailProfileId})`,
                  hint: "recommended for account visibility",
                },
                { value: altProfileId, label: `altN (${altProfileId})`, hint: "next free alias" },
                {
                  value: "__custom__",
                  label: "custom",
                  hint: "set any provider:profile id",
                },
                {
                  value: defaultProfileId,
                  label: `default (${defaultProfileId})`,
                  hint: "will overwrite current default",
                },
              ],
            }),
          ).trim();
          if (choice === "__custom__") {
            requestedProfileId = String(
              await params.prompter.text({
                message: "Custom profile id",
                initialValue: altProfileId,
              }),
            ).trim();
          } else {
            requestedProfileId = choice;
          }
        }
      }

      const profileId = await writeOAuthCredentials("openai-codex", creds, params.agentDir, {
        syncSiblingAgents: true,
        profileId: requestedProfileId || undefined,
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
    }
    return { config: nextConfig, agentModelOverride };
  }

  return null;
}
