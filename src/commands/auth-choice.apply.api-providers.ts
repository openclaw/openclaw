import {
  loadAuthProfileStoreForSecretsRuntime,
  resolveAuthProfileOrder,
} from "../agents/auth-profiles.js";
import { resolveGigachatAuthMode } from "../agents/gigachat-auth.js";
import { resolveManifestProviderApiKeyChoice } from "../plugins/provider-auth-choices.js";
import { ensureApiKeyFromOptionEnvOrPrompt } from "./auth-choice.apply-helpers.js";
import {
  createAuthChoiceDefaultModelApplierForMutableState,
  normalizeSecretInputModeInput,
  normalizeTokenProviderInput,
} from "./auth-choice.apply-helpers.js";
import { applyLiteLlmApiKeyProvider } from "./auth-choice.apply.api-key-providers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import {
  applyAuthProfileConfig,
  applyGigachatConfig,
  applyGigachatProviderConfig,
  GIGACHAT_DEFAULT_MODEL_REF,
  setGigachatApiKey,
} from "./onboard-auth.js";
import { GIGACHAT_BASE_URL } from "./onboard-auth.models.js";
import type { AuthChoice } from "./onboard-types.js";

const CORE_API_KEY_TOKEN_PROVIDER_AUTH_CHOICES: Partial<Record<string, AuthChoice>> = {
  gigachat: "gigachat-oauth",
  litellm: "litellm-api-key",
};

function hasActiveGigachatBasicProfile(
  cfg: ApplyAuthChoiceParams["config"],
  agentDir?: string,
): boolean {
  const store = loadAuthProfileStoreForSecretsRuntime(agentDir);
  const activeProfileId = resolveAuthProfileOrder({ cfg, store, provider: "gigachat" })[0];
  const profile = activeProfileId ? store.profiles[activeProfileId] : undefined;
  return (
    profile?.type === "api_key" &&
    profile.provider === "gigachat" &&
    profile.metadata?.authMode === "basic"
  );
}

export function normalizeApiKeyTokenProviderAuthChoice(params: {
  authChoice: AuthChoice;
  tokenProvider?: string;
  config?: ApplyAuthChoiceParams["config"];
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): AuthChoice {
  if (params.authChoice !== "apiKey" || !params.tokenProvider) {
    return params.authChoice;
  }
  const normalizedTokenProvider = normalizeTokenProviderInput(params.tokenProvider);
  if (!normalizedTokenProvider) {
    return params.authChoice;
  }
  return (
    (resolveManifestProviderApiKeyChoice({
      providerId: normalizedTokenProvider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    })?.choiceId as AuthChoice | undefined) ??
    CORE_API_KEY_TOKEN_PROVIDER_AUTH_CHOICES[normalizedTokenProvider] ??
    params.authChoice
  );
}

export async function applyAuthChoiceApiProviders(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  let nextConfig = params.config;
  let agentModelOverride: string | undefined;
  const applyProviderDefaultModel = createAuthChoiceDefaultModelApplierForMutableState(
    params,
    () => nextConfig,
    (config) => (nextConfig = config),
    () => agentModelOverride,
    (model) => (agentModelOverride = model),
  );

  let authChoice = normalizeApiKeyTokenProviderAuthChoice({
    authChoice: params.authChoice,
    tokenProvider: params.opts?.tokenProvider,
    config: params.config,
    env: process.env,
  });
  const normalizedTokenProvider = normalizeTokenProviderInput(params.opts?.tokenProvider);
  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);

  const litellmResult = await applyLiteLlmApiKeyProvider({
    params,
    authChoice,
    config: nextConfig,
    setConfig: (config) => (nextConfig = config),
    getConfig: () => nextConfig,
    normalizedTokenProvider,
    requestedSecretInputMode,
    applyProviderDefaultModel,
    getAgentModelOverride: () => agentModelOverride,
  });
  if (litellmResult) {
    return litellmResult;
  }

  let gigachatBasicScope: string | undefined;
  if (
    authChoice === "gigachat-personal" ||
    authChoice === "gigachat-business" ||
    authChoice === "gigachat-oauth" ||
    authChoice === "gigachat-api-key"
  ) {
    const isPersonal =
      authChoice === "gigachat-personal" ||
      authChoice === "gigachat-oauth" ||
      authChoice === "gigachat-api-key";
    const accountLabel = isPersonal ? "Personal" : "Business";
    const gigachatScope = isPersonal
      ? "GIGACHAT_API_PERS"
      : String(
          await params.prompter.select({
            message: "Select billing type",
            options: [
              { value: "GIGACHAT_API_B2B", label: "Prepaid" },
              { value: "GIGACHAT_API_CORP", label: "Postpaid" },
            ],
          }),
        );

    const selectedAuth = String(
      await params.prompter.select({
        message: `Select ${accountLabel} authentication method`,
        options: [
          { value: "oauth", label: "OAuth", hint: "credentials key -> access token (recommended)" },
          { value: "basic", label: "Basic auth", hint: "username + password + custom URL" },
        ],
      }),
    );

    if (selectedAuth === "basic") {
      authChoice = "gigachat-basic";
      gigachatBasicScope = gigachatScope;
    } else {
      const resetGigachatBaseUrl = hasActiveGigachatBasicProfile(nextConfig, params.agentDir);
      await ensureApiKeyFromOptionEnvOrPrompt({
        token: params.opts?.gigachatApiKey ?? params.opts?.token,
        provider: "gigachat",
        tokenProvider: normalizedTokenProvider,
        secretInputMode: requestedSecretInputMode,
        config: nextConfig,
        expectedProviders: ["gigachat"],
        envLabel: "GIGACHAT_CREDENTIALS",
        promptMessage: "Enter GigaChat credentials key (from developers.sber.ru/studio)",
        normalize: (value) => String(value ?? "").trim(),
        validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        prompter: params.prompter,
        setCredential: async (apiKey, mode) => {
          if (typeof apiKey === "string" && resolveGigachatAuthMode({ apiKey }) === "basic") {
            params.runtime.error(
              [
                "GIGACHAT_CREDENTIALS looks like Basic user:password credentials.",
                "You selected the OAuth flow, which only supports credentials keys.",
                'Choose "Basic auth" instead, or set GIGACHAT_CREDENTIALS to a real OAuth credentials key and retry.',
              ].join("\n"),
            );
            params.runtime.exit(1);
            return;
          }
          await setGigachatApiKey(
            apiKey,
            params.agentDir,
            { secretInputMode: mode ?? requestedSecretInputMode },
            {
              authMode: "oauth",
              scope: gigachatScope,
            },
          );
        },
        noteMessage: [
          `GigaChat ${accountLabel} (OAuth, ${gigachatScope}).`,
          "Your credentials key will be exchanged for an access token automatically.",
          "Get your key at: https://developers.sber.ru/studio/",
        ].join("\n"),
        noteTitle: `GigaChat (${accountLabel})`,
      });

      nextConfig = applyAuthProfileConfig(nextConfig, {
        profileId: "gigachat:default",
        provider: "gigachat",
        mode: "api_key",
      });
      await applyProviderDefaultModel({
        defaultModel: GIGACHAT_DEFAULT_MODEL_REF,
        applyDefaultConfig: (config) =>
          applyGigachatConfig(
            config,
            resetGigachatBaseUrl ? { baseUrl: GIGACHAT_BASE_URL } : undefined,
          ),
        applyProviderConfig: (config) =>
          applyGigachatProviderConfig(
            config,
            resetGigachatBaseUrl ? { baseUrl: GIGACHAT_BASE_URL } : undefined,
          ),
        noteDefault: GIGACHAT_DEFAULT_MODEL_REF,
      });
      return { config: nextConfig, agentModelOverride };
    }
  }

  if (authChoice === "gigachat-basic") {
    if (!gigachatBasicScope) {
      gigachatBasicScope = String(
        await params.prompter.select({
          message: "Select billing type",
          options: [
            { value: "GIGACHAT_API_PERS", label: "Personal" },
            { value: "GIGACHAT_API_B2B", label: "Business (Prepaid)" },
            { value: "GIGACHAT_API_CORP", label: "Business (Postpaid)" },
          ],
        }),
      );
    }
    const envBaseUrl = process.env.GIGACHAT_BASE_URL?.trim() ?? "";
    const envUser = process.env.GIGACHAT_USER?.trim() ?? "";
    const envPassword = process.env.GIGACHAT_PASSWORD?.trim() ?? "";

    let baseUrl = envBaseUrl;
    if (!baseUrl) {
      const value = await params.prompter.text({
        message: "Enter GigaChat base URL",
        initialValue: "https://gigachat.ift.sberdevices.ru/v1",
        validate: (val) => (String(val ?? "").trim() ? undefined : "Base URL is required"),
      });
      baseUrl = String(value ?? "").trim();
    }

    let username = envUser;
    if (!username) {
      const value = await params.prompter.text({
        message: "Enter GigaChat username",
        validate: (val) => (String(val ?? "").trim() ? undefined : "Username is required"),
      });
      username = String(value ?? "").trim();
    }

    let password = envPassword;
    if (!password) {
      const value = await params.prompter.text({
        message: "Enter GigaChat password",
        validate: (val) => (String(val ?? "").trim() ? undefined : "Password is required"),
      });
      password = String(value ?? "").trim();
    }

    const basicMetadata: Record<string, string> = {
      authMode: "basic",
      ...(gigachatBasicScope ? { scope: gigachatBasicScope } : {}),
    };

    await setGigachatApiKey(`${username}:${password}`, params.agentDir, undefined, basicMetadata);

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "gigachat:default",
      provider: "gigachat",
      mode: "api_key",
    });
    await applyProviderDefaultModel({
      defaultModel: GIGACHAT_DEFAULT_MODEL_REF,
      applyDefaultConfig: (config) => applyGigachatConfig(config, { baseUrl }),
      applyProviderConfig: (config) => applyGigachatProviderConfig(config, { baseUrl }),
      noteDefault: GIGACHAT_DEFAULT_MODEL_REF,
    });

    await params.prompter.note(
      [
        "GigaChat (Basic auth).",
        `Base URL: ${baseUrl}`,
        `Username: ${username}`,
        ...(gigachatBasicScope ? [`Scope: ${gigachatBasicScope}`] : []),
      ].join("\n"),
      "GigaChat configured",
    );

    return { config: nextConfig, agentModelOverride };
  }

  return null;
}
