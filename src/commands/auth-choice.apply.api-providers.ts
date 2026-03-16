import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  normalizeSecretInputModeInput,
  createAuthChoiceAgentModelNoter,
  createAuthChoiceDefaultModelApplierForMutableState,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeTokenProviderInput,
} from "./auth-choice.apply-helpers.js";
import {
  applyLiteLlmApiKeyProvider,
  applySimpleAuthChoiceApiProvider,
} from "./auth-choice.apply.api-key-providers.js";
import { applyAuthChoiceHuggingface } from "./auth-choice.apply.huggingface.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyAuthChoiceOpenRouter } from "./auth-choice.apply.openrouter.js";
import {
  applyGoogleGeminiModelDefault,
  GOOGLE_GEMINI_DEFAULT_MODEL,
} from "./google-gemini-model-default.js";
import {
  applyAuthProfileConfig,
  applyCloudflareAiGatewayConfig,
  applyCloudflareAiGatewayProviderConfig,
  applyKilocodeConfig,
  applyKilocodeProviderConfig,
  applyQianfanConfig,
  applyQianfanProviderConfig,
  applyKimiCodeConfig,
  applyKimiCodeProviderConfig,
  applyLitellmConfig,
  applyLitellmProviderConfig,
  applyGigachatConfig,
  applyGigachatProviderConfig,
  applyMistralConfig,
  applyMistralProviderConfig,
  applyMoonshotConfig,
  applyMoonshotConfigCn,
  applyMoonshotProviderConfig,
  applyMoonshotProviderConfigCn,
  applyOpencodeGoConfig,
  applyOpencodeGoProviderConfig,
  applyOpencodeZenConfig,
  applyOpencodeZenProviderConfig,
  applySyntheticConfig,
  applySyntheticProviderConfig,
  applyTogetherConfig,
  applyTogetherProviderConfig,
  applyVeniceConfig,
  applyVeniceProviderConfig,
  applyVercelAiGatewayConfig,
  applyVercelAiGatewayProviderConfig,
  applyXiaomiConfig,
  applyXiaomiProviderConfig,
  applyZaiConfig,
  applyZaiProviderConfig,
  CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  KILOCODE_DEFAULT_MODEL_REF,
  LITELLM_DEFAULT_MODEL_REF,
  QIANFAN_DEFAULT_MODEL_REF,
  KIMI_CODING_MODEL_REF,
  MOONSHOT_DEFAULT_MODEL_REF,
  GIGACHAT_DEFAULT_MODEL_REF,
  MISTRAL_DEFAULT_MODEL_REF,
  SYNTHETIC_DEFAULT_MODEL_REF,
  TOGETHER_DEFAULT_MODEL_REF,
  VENICE_DEFAULT_MODEL_REF,
  VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
  XIAOMI_DEFAULT_MODEL_REF,
  setCloudflareAiGatewayConfig,
  setGeminiApiKey,
  setKilocodeApiKey,
  setLitellmApiKey,
  setKimiCodingApiKey,
  setGigachatApiKey,
  setMistralApiKey,
  setMoonshotApiKey,
  setOpencodeGoApiKey,
  setOpencodeZenApiKey,
  setSyntheticApiKey,
  setTogetherApiKey,
  setVeniceApiKey,
  setVercelAiGatewayApiKey,
  setXiaomiApiKey,
  setZaiApiKey,
  ZAI_DEFAULT_MODEL_REF,
} from "./onboard-auth.js";
import type { AuthChoice } from "./onboard-types.js";
import { detectZaiEndpoint } from "./zai-endpoint-detect.js";

const API_KEY_TOKEN_PROVIDER_AUTH_CHOICE: Record<string, AuthChoice> = {
  openrouter: "openrouter-api-key",
  litellm: "litellm-api-key",
  "vercel-ai-gateway": "ai-gateway-api-key",
  "cloudflare-ai-gateway": "cloudflare-ai-gateway-api-key",
  moonshot: "moonshot-api-key",
  "kimi-code": "kimi-code-api-key",
  "kimi-coding": "kimi-code-api-key",
  google: "gemini-api-key",
  zai: "zai-api-key",
  xiaomi: "xiaomi-api-key",
  synthetic: "synthetic-api-key",
  venice: "venice-api-key",
  together: "together-api-key",
  huggingface: "huggingface-api-key",
  mistral: "mistral-api-key",
  gigachat: "gigachat-oauth",
  opencode: "opencode-zen",
  "opencode-go": "opencode-go",
  kilocode: "kilocode-api-key",
  qianfan: "qianfan-api-key",
};

const ZAI_AUTH_CHOICE_ENDPOINT: Partial<
  Record<AuthChoice, "global" | "cn" | "coding-global" | "coding-cn">
> = {
  "zai-coding-global": "coding-global",
  "zai-coding-cn": "coding-cn",
  "zai-global": "global",
  "zai-cn": "cn",
};

export function normalizeApiKeyTokenProviderAuthChoice(params: {
  authChoice: AuthChoice;
  tokenProvider?: string;
}): AuthChoice {
  if (params.authChoice !== "apiKey" || !params.tokenProvider) {
    return params.authChoice;
  }
  const normalizedTokenProvider = normalizeTokenProviderInput(params.tokenProvider);
  if (!normalizedTokenProvider) {
    return params.authChoice;
  }
  if (normalizedTokenProvider === "anthropic" || normalizedTokenProvider === "openai") {
    return params.authChoice;
  }
  return API_KEY_TOKEN_PROVIDER_AUTH_CHOICE[normalizedTokenProvider] ?? params.authChoice;
}

export async function applyAuthChoiceApiProviders(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  let nextConfig = params.config;
  let agentModelOverride: string | undefined;
  const noteAgentModel = createAuthChoiceAgentModelNoter(params);
  const applyProviderDefaultModel = createAuthChoiceDefaultModelApplierForMutableState(
    params,
    () => nextConfig,
    (config) => (nextConfig = config),
    () => agentModelOverride,
    (model) => (agentModelOverride = model),
  );

  const authChoice = normalizeApiKeyTokenProviderAuthChoice({
    authChoice: params.authChoice,
    tokenProvider: params.opts?.tokenProvider,
  });
  const normalizedTokenProvider = normalizeTokenProviderInput(params.opts?.tokenProvider);
  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);

  if (authChoice === "openrouter-api-key") {
    return applyAuthChoiceOpenRouter(params);
  }

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

  const simpleProviderResult = await applySimpleAuthChoiceApiProvider({
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
  if (simpleProviderResult) {
    return simpleProviderResult;
  }

  if (authChoice === "cloudflare-ai-gateway-api-key") {
    let accountId = params.opts?.cloudflareAiGatewayAccountId?.trim() ?? "";
    let gatewayId = params.opts?.cloudflareAiGatewayGatewayId?.trim() ?? "";

    const ensureAccountGateway = async () => {
      if (!accountId) {
        const value = await params.prompter.text({
          message: "Enter Cloudflare Account ID",
          validate: (val) => (String(val ?? "").trim() ? undefined : "Account ID is required"),
        });
        accountId = String(value ?? "").trim();
      }
      if (!gatewayId) {
        const value = await params.prompter.text({
          message: "Enter Cloudflare AI Gateway ID",
          validate: (val) => (String(val ?? "").trim() ? undefined : "Gateway ID is required"),
        });
        gatewayId = String(value ?? "").trim();
      }
    };

    await ensureAccountGateway();

    await ensureApiKeyFromOptionEnvOrPrompt({
      token: params.opts?.cloudflareAiGatewayApiKey,
      tokenProvider: "cloudflare-ai-gateway",
      secretInputMode: requestedSecretInputMode,
      config: nextConfig,
      expectedProviders: ["cloudflare-ai-gateway"],
      provider: "cloudflare-ai-gateway",
      envLabel: "CLOUDFLARE_AI_GATEWAY_API_KEY",
      promptMessage: "Enter Cloudflare AI Gateway API key",
      normalize: normalizeApiKeyInput,
      validate: validateApiKeyInput,
      prompter: params.prompter,
      setCredential: async (apiKey, mode) =>
        setCloudflareAiGatewayConfig(accountId, gatewayId, apiKey, params.agentDir, {
          secretInputMode: mode,
        }),
    });

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "cloudflare-ai-gateway:default",
      provider: "cloudflare-ai-gateway",
      mode: "api_key",
    });
    await applyProviderDefaultModel({
      defaultModel: CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
      applyDefaultConfig: (cfg) =>
        applyCloudflareAiGatewayConfig(cfg, {
          accountId: accountId || params.opts?.cloudflareAiGatewayAccountId,
          gatewayId: gatewayId || params.opts?.cloudflareAiGatewayGatewayId,
        }),
      applyProviderConfig: (cfg) =>
        applyCloudflareAiGatewayProviderConfig(cfg, {
          accountId: accountId || params.opts?.cloudflareAiGatewayAccountId,
          gatewayId: gatewayId || params.opts?.cloudflareAiGatewayGatewayId,
        }),
      noteDefault: CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
    });
    return { config: nextConfig, agentModelOverride };
  }

  if (authChoice === "gemini-api-key") {
    await ensureApiKeyFromOptionEnvOrPrompt({
      token: params.opts?.token,
      provider: "google",
      tokenProvider: normalizedTokenProvider,
      secretInputMode: requestedSecretInputMode,
      config: nextConfig,
      expectedProviders: ["google"],
      envLabel: "GEMINI_API_KEY",
      promptMessage: "Enter Gemini API key",
      normalize: normalizeApiKeyInput,
      validate: validateApiKeyInput,
      prompter: params.prompter,
      setCredential: async (apiKey, mode) =>
        setGeminiApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
    });
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "google:default",
      provider: "google",
      mode: "api_key",
    });
    if (params.setDefaultModel) {
      const applied = applyGoogleGeminiModelDefault(nextConfig);
      nextConfig = applied.next;
      if (applied.changed) {
        await params.prompter.note(
          `Default model set to ${GOOGLE_GEMINI_DEFAULT_MODEL}`,
          "Model configured",
        );
      }
    } else {
      agentModelOverride = GOOGLE_GEMINI_DEFAULT_MODEL;
      await noteAgentModel(GOOGLE_GEMINI_DEFAULT_MODEL);
    }
    return { config: nextConfig, agentModelOverride };
  }

  if (
    authChoice === "zai-api-key" ||
    authChoice === "zai-coding-global" ||
    authChoice === "zai-coding-cn" ||
    authChoice === "zai-global" ||
    authChoice === "zai-cn"
  ) {
    let endpoint = ZAI_AUTH_CHOICE_ENDPOINT[authChoice];

    const apiKey = await ensureApiKeyFromOptionEnvOrPrompt({
      token: params.opts?.token,
      provider: "zai",
      tokenProvider: normalizedTokenProvider,
      secretInputMode: requestedSecretInputMode,
      config: nextConfig,
      expectedProviders: ["zai"],
      envLabel: "ZAI_API_KEY",
      promptMessage: "Enter Z.AI API key",
      normalize: normalizeApiKeyInput,
      validate: validateApiKeyInput,
      prompter: params.prompter,
      setCredential: async (apiKey, mode) =>
        setZaiApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
    });

    let modelIdOverride: string | undefined;
    if (endpoint) {
      const detected = await detectZaiEndpoint({ apiKey, endpoint });
      if (detected) {
        modelIdOverride = detected.modelId;
        await params.prompter.note(detected.note, "Z.AI endpoint");
      }
    } else {
      // zai-api-key: auto-detect endpoint + choose a working default model.
      const detected = await detectZaiEndpoint({ apiKey });
      if (detected) {
        endpoint = detected.endpoint;
        modelIdOverride = detected.modelId;
        await params.prompter.note(detected.note, "Z.AI endpoint");
      } else {
        endpoint = await params.prompter.select({
          message: "Select Z.AI endpoint",
          options: [
            {
              value: "coding-global",
              label: "Coding-Plan-Global",
              hint: "GLM Coding Plan Global (api.z.ai)",
            },
            {
              value: "coding-cn",
              label: "Coding-Plan-CN",
              hint: "GLM Coding Plan CN (open.bigmodel.cn)",
            },
            {
              value: "global",
              label: "Global",
              hint: "Z.AI Global (api.z.ai)",
            },
            {
              value: "cn",
              label: "CN",
              hint: "Z.AI CN (open.bigmodel.cn)",
            },
          ],
          initialValue: "global",
        });
      }
    }

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "zai:default",
      provider: "zai",
      mode: "api_key",
    });

    const defaultModel = modelIdOverride ? `zai/${modelIdOverride}` : ZAI_DEFAULT_MODEL_REF;
    await applyProviderDefaultModel({
      defaultModel,
      applyDefaultConfig: (config) =>
        applyZaiConfig(config, {
          endpoint,
          ...(modelIdOverride ? { modelId: modelIdOverride } : {}),
        }),
      applyProviderConfig: (config) =>
        applyZaiProviderConfig(config, {
          endpoint,
          ...(modelIdOverride ? { modelId: modelIdOverride } : {}),
        }),
      noteDefault: defaultModel,
    });

    return { config: nextConfig, agentModelOverride };
  }

  if (authChoice === "huggingface-api-key") {
    return applyAuthChoiceHuggingface({ ...params, authChoice });
  }

  // Scope selected during personal/business flow, passed to gigachat-basic if needed
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

    // For business, ask billing type first, then auth method.
    // For personal, scope is fixed (GIGACHAT_API_PERS).
    let gigachatScope: string;
    if (isPersonal) {
      gigachatScope = "GIGACHAT_API_PERS";
    } else {
      const billingChoice = String(
        await params.prompter.select({
          message: "Select billing type",
          options: [
            { value: "GIGACHAT_API_B2B", label: "Prepaid" },
            { value: "GIGACHAT_API_CORP", label: "Postpaid" },
          ],
        }),
      );
      gigachatScope = billingChoice;
    }

    const selectedAuth = String(
      await params.prompter.select({
        message: `Select ${accountLabel} authentication method`,
        options: [
          { value: "oauth", label: "OAuth", hint: "credentials key → access token (recommended)" },
          { value: "basic", label: "Basic auth", hint: "username + password + custom URL" },
        ],
      }),
    );

    if (selectedAuth === "basic") {
      authChoice = "gigachat-basic";
      gigachatBasicScope = gigachatScope;
    } else {
      const gigachatMetadata: Record<string, string> = {
        authMode: "oauth",
        scope: gigachatScope,
        insecureTls: "false",
      };

      await ensureApiKeyFromOptionEnvOrPrompt({
        token: params.opts?.token,
        provider: "gigachat",
        tokenProvider: normalizedTokenProvider,
        secretInputMode: requestedSecretInputMode,
        config: nextConfig,
        expectedProviders: ["gigachat"],
        envLabel: "GIGACHAT_CREDENTIALS",
        promptMessage: "Enter GigaChat credentials key (from developers.sber.ru/studio)",
        setCredential: async (apiKey, mode) => {
          await setGigachatApiKey(
            apiKey,
            params.agentDir,
            { secretInputMode: mode ?? requestedSecretInputMode },
            gigachatMetadata,
          );
        },
        noteMessage: [
          `GigaChat ${accountLabel} (OAuth, ${gigachatScope}).`,
          "Your credentials key will be exchanged for an access token automatically.",
          "Get your key at: https://developers.sber.ru/studio/",
        ].join("\n"),
        noteTitle: `GigaChat (${accountLabel})`,
        // GigaChat credentials are base64-encoded (end with "==") — the default
        // normalizeApiKeyInput false-matches the trailing "=" as a shell assignment.
        normalize: (value) => String(value ?? "").trim(),
        validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        prompter: params.prompter,
      });

      nextConfig = applyAuthProfileConfig(nextConfig, {
        profileId: "gigachat:default",
        provider: "gigachat",
        mode: "api_key",
      });
      await applyProviderDefaultModel({
        defaultModel: GIGACHAT_DEFAULT_MODEL_REF,
        applyDefaultConfig: applyGigachatConfig,
        applyProviderConfig: applyGigachatProviderConfig,
        noteDefault: GIGACHAT_DEFAULT_MODEL_REF,
      });

      return { config: nextConfig, agentModelOverride };
    }
  }

  if (authChoice === "gigachat-basic") {
    const envBaseUrl = process.env.GIGACHAT_BASE_URL?.trim() ?? "";
    const envUser = process.env.GIGACHAT_USER?.trim() ?? "";
    const envPassword = process.env.GIGACHAT_PASSWORD?.trim() ?? "";

    let baseUrl = envBaseUrl;
    if (!baseUrl) {
      const baseUrlValue = await params.prompter.text({
        message: "Enter GigaChat base URL",
        initialValue: "https://gigachat.ift.sberdevices.ru/v1",
        validate: (val) => (String(val ?? "").trim() ? undefined : "Base URL is required"),
      });
      baseUrl = String(baseUrlValue ?? "").trim();
    }

    let username = envUser;
    if (!username) {
      const usernameValue = await params.prompter.text({
        message: "Enter GigaChat username",
        validate: (val) => (String(val ?? "").trim() ? undefined : "Username is required"),
      });
      username = String(usernameValue ?? "").trim();
    }

    let password = envPassword;
    if (!password) {
      const passwordValue = await params.prompter.text({
        message: "Enter GigaChat password",
        validate: (val) => (String(val ?? "").trim() ? undefined : "Password is required"),
      });
      password = String(passwordValue ?? "").trim();
    }

    const basicMetadata: Record<string, string> = {
      authMode: "basic",
      insecureTls: "false",
      ...(gigachatBasicScope ? { scope: gigachatBasicScope } : {}),
    };

    await setGigachatApiKey(
      `${username}:${password}`,
      params.agentDir,
      { secretInputMode: requestedSecretInputMode },
      basicMetadata,
    );

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "gigachat:default",
      provider: "gigachat",
      mode: "api_key",
    });
    await applyProviderDefaultModel({
      defaultModel: GIGACHAT_DEFAULT_MODEL_REF,
      applyDefaultConfig: (cfg) => applyGigachatConfig(cfg, { baseUrl }),
      applyProviderConfig: (cfg) => applyGigachatProviderConfig(cfg, { baseUrl }),
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
