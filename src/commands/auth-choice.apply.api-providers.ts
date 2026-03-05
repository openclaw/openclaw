import { ensureAuthProfileStore, resolveAuthProfileOrder } from "../agents/auth-profiles.js";
import type { SecretInput } from "../config/types.secrets.js";
import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  normalizeSecretInputModeInput,
  createAuthChoiceAgentModelNoter,
  createAuthChoiceDefaultModelApplierForMutableState,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeTokenProviderInput,
} from "./auth-choice.apply-helpers.js";
import { applyAuthChoiceHuggingface } from "./auth-choice.apply.huggingface.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyAuthChoiceOpenRouter } from "./auth-choice.apply.openrouter.js";
import {
  applyGoogleGeminiModelDefault,
  GOOGLE_GEMINI_DEFAULT_MODEL,
} from "./google-gemini-model-default.js";
import { applyPrimaryModel } from "./model-picker.js";
import type { ApiKeyStorageOptions } from "./onboard-auth.credentials.js";
import {
  applyAuthProfileConfig,
  applyCloudflareAiGatewayConfig,
  applyCloudflareAiGatewayProviderConfig,
  applyAipingProviderConfig,
  applyKilocodeConfig,
  applyKilocodeProviderConfig,
  applyQianfanConfig,
  applyQianfanProviderConfig,
  applyKimiCodeConfig,
  applyKimiCodeProviderConfig,
  applyLitellmConfig,
  applyLitellmProviderConfig,
  applyMistralConfig,
  applyMistralProviderConfig,
  applyMoonshotConfig,
  applyMoonshotConfigCn,
  applyMoonshotProviderConfig,
  applyMoonshotProviderConfigCn,
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
  AIPING_DEFAULT_MODEL_REF,
  KILOCODE_DEFAULT_MODEL_REF,
  LITELLM_DEFAULT_MODEL_REF,
  QIANFAN_DEFAULT_MODEL_REF,
  KIMI_CODING_MODEL_REF,
  MOONSHOT_DEFAULT_MODEL_REF,
  MISTRAL_DEFAULT_MODEL_REF,
  SYNTHETIC_DEFAULT_MODEL_REF,
  TOGETHER_DEFAULT_MODEL_REF,
  VENICE_DEFAULT_MODEL_REF,
  VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
  XIAOMI_DEFAULT_MODEL_REF,
  setCloudflareAiGatewayConfig,
  setAipingApiKey,
  setQianfanApiKey,
  setGeminiApiKey,
  setKilocodeApiKey,
  setLitellmApiKey,
  setKimiCodingApiKey,
  setMistralApiKey,
  setMoonshotApiKey,
  setOpencodeZenApiKey,
  setSyntheticApiKey,
  setTogetherApiKey,
  setVeniceApiKey,
  setVercelAiGatewayApiKey,
  setXiaomiApiKey,
  setZaiApiKey,
  ZAI_DEFAULT_MODEL_REF,
} from "./onboard-auth.js";
import type { AuthChoice, SecretInputMode } from "./onboard-types.js";
import { OPENCODE_ZEN_DEFAULT_MODEL } from "./opencode-zen-model-default.js";
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
  opencode: "opencode-zen",
  kilocode: "kilocode-api-key",
  qianfan: "qianfan-api-key",
  aiping: "aiping-api-key",
};

const ZAI_AUTH_CHOICE_ENDPOINT: Partial<
  Record<AuthChoice, "global" | "cn" | "coding-global" | "coding-cn">
> = {
  "zai-coding-global": "coding-global",
  "zai-coding-cn": "coding-cn",
  "zai-global": "global",
  "zai-cn": "cn",
};

type ApiKeyProviderConfigApplier = (
  config: ApplyAuthChoiceParams["config"],
) => ApplyAuthChoiceParams["config"];

type SimpleApiKeyProviderFlow = {
  provider: Parameters<typeof ensureApiKeyFromOptionEnvOrPrompt>[0]["provider"];
  profileId: string;
  expectedProviders: string[];
  envLabel: string;
  promptMessage: string;
  setCredential: (
    apiKey: SecretInput,
    agentDir?: string,
    options?: ApiKeyStorageOptions,
  ) => void | Promise<void>;
  defaultModel: string;
  applyDefaultConfig: ApiKeyProviderConfigApplier;
  applyProviderConfig: ApiKeyProviderConfigApplier;
  tokenProvider?: string;
  normalize?: (value: string) => string;
  validate?: (value: string) => string | undefined;
  noteDefault?: string;
  noteMessage?: string;
  noteTitle?: string;
};

type AipingRoutingPreset = "default" | "latency" | "throughput" | "price";

type AipingRoutingSelection = {
  preset: AipingRoutingPreset;
  modelRef: string;
  alias: string;
};

const AIPING_ROUTING_PRESET_OPTIONS: Array<{
  value: AipingRoutingPreset;
  label: string;
  hint: string;
}> = [
  {
    value: "default",
    label: "Balanced (provider default)",
    hint: "DeepSeek-V3.2",
  },
  {
    value: "latency",
    label: "Low latency",
    hint: "DeepSeek-V3.2:latency",
  },
  {
    value: "throughput",
    label: "High throughput",
    hint: "DeepSeek-V3.2:throughput",
  },
  {
    value: "price",
    label: "Lowest input price",
    hint: "DeepSeek-V3.2:input_price",
  },
];

function resolveAipingRoutingSelection(preset: AipingRoutingPreset): AipingRoutingSelection {
  if (preset === "latency") {
    return {
      preset,
      modelRef: "aiping/DeepSeek-V3.2:latency",
      alias: "AIPing (Latency)",
    };
  }
  if (preset === "throughput") {
    return {
      preset,
      modelRef: "aiping/DeepSeek-V3.2:throughput",
      alias: "AIPing (Throughput)",
    };
  }
  if (preset === "price") {
    return {
      preset,
      modelRef: "aiping/DeepSeek-V3.2:input_price",
      alias: "AIPing (Price)",
    };
  }
  return {
    preset: "default",
    modelRef: AIPING_DEFAULT_MODEL_REF,
    alias: "AIPing",
  };
}

function applyAipingProviderConfigForModel(
  config: ApplyAuthChoiceParams["config"],
  selection: AipingRoutingSelection,
): ApplyAuthChoiceParams["config"] {
  const next = applyAipingProviderConfig(config);
  const models = { ...next.agents?.defaults?.models };
  models[selection.modelRef] = {
    ...models[selection.modelRef],
    alias: models[selection.modelRef]?.alias ?? selection.alias,
  };
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        models,
      },
    },
  };
}

async function resolveAipingRoutingPreset(params: {
  authChoice: AuthChoice;
  normalizedTokenProvider: string | undefined;
  token?: string;
  prompter: ApplyAuthChoiceParams["prompter"];
}): Promise<AipingRoutingSelection> {
  const tokenDrivenFlow =
    params.authChoice === "apiKey" &&
    params.normalizedTokenProvider === "aiping" &&
    typeof params.token === "string" &&
    params.token.trim().length > 0;
  if (tokenDrivenFlow || typeof params.prompter.select !== "function") {
    return resolveAipingRoutingSelection("default");
  }

  const selected = await params.prompter.select<AipingRoutingPreset>({
    message: "Select AIPing routing preset",
    initialValue: "default",
    options: AIPING_ROUTING_PRESET_OPTIONS,
  });
  const preset: AipingRoutingPreset =
    selected === "latency" || selected === "throughput" || selected === "price"
      ? selected
      : "default";
  return resolveAipingRoutingSelection(preset);
}

const SIMPLE_API_KEY_PROVIDER_FLOWS: Partial<Record<AuthChoice, SimpleApiKeyProviderFlow>> = {
  "ai-gateway-api-key": {
    provider: "vercel-ai-gateway",
    profileId: "vercel-ai-gateway:default",
    expectedProviders: ["vercel-ai-gateway"],
    envLabel: "AI_GATEWAY_API_KEY",
    promptMessage: "Enter Vercel AI Gateway API key",
    setCredential: setVercelAiGatewayApiKey,
    defaultModel: VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
    applyDefaultConfig: applyVercelAiGatewayConfig,
    applyProviderConfig: applyVercelAiGatewayProviderConfig,
    noteDefault: VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
  },
  "moonshot-api-key": {
    provider: "moonshot",
    profileId: "moonshot:default",
    expectedProviders: ["moonshot"],
    envLabel: "MOONSHOT_API_KEY",
    promptMessage: "Enter Moonshot API key",
    setCredential: setMoonshotApiKey,
    defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
    applyDefaultConfig: applyMoonshotConfig,
    applyProviderConfig: applyMoonshotProviderConfig,
  },
  "moonshot-api-key-cn": {
    provider: "moonshot",
    profileId: "moonshot:default",
    expectedProviders: ["moonshot"],
    envLabel: "MOONSHOT_API_KEY",
    promptMessage: "Enter Moonshot API key (.cn)",
    setCredential: setMoonshotApiKey,
    defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
    applyDefaultConfig: applyMoonshotConfigCn,
    applyProviderConfig: applyMoonshotProviderConfigCn,
  },
  "kimi-code-api-key": {
    provider: "kimi-coding",
    profileId: "kimi-coding:default",
    expectedProviders: ["kimi-code", "kimi-coding"],
    envLabel: "KIMI_API_KEY",
    promptMessage: "Enter Kimi Coding API key",
    setCredential: setKimiCodingApiKey,
    defaultModel: KIMI_CODING_MODEL_REF,
    applyDefaultConfig: applyKimiCodeConfig,
    applyProviderConfig: applyKimiCodeProviderConfig,
    noteDefault: KIMI_CODING_MODEL_REF,
    noteMessage: [
      "Kimi Coding uses a dedicated endpoint and API key.",
      "Get your API key at: https://www.kimi.com/code/en",
    ].join("\n"),
    noteTitle: "Kimi Coding",
  },
  "xiaomi-api-key": {
    provider: "xiaomi",
    profileId: "xiaomi:default",
    expectedProviders: ["xiaomi"],
    envLabel: "XIAOMI_API_KEY",
    promptMessage: "Enter Xiaomi API key",
    setCredential: setXiaomiApiKey,
    defaultModel: XIAOMI_DEFAULT_MODEL_REF,
    applyDefaultConfig: applyXiaomiConfig,
    applyProviderConfig: applyXiaomiProviderConfig,
    noteDefault: XIAOMI_DEFAULT_MODEL_REF,
  },
  "mistral-api-key": {
    provider: "mistral",
    profileId: "mistral:default",
    expectedProviders: ["mistral"],
    envLabel: "MISTRAL_API_KEY",
    promptMessage: "Enter Mistral API key",
    setCredential: setMistralApiKey,
    defaultModel: MISTRAL_DEFAULT_MODEL_REF,
    applyDefaultConfig: applyMistralConfig,
    applyProviderConfig: applyMistralProviderConfig,
    noteDefault: MISTRAL_DEFAULT_MODEL_REF,
  },
  "venice-api-key": {
    provider: "venice",
    profileId: "venice:default",
    expectedProviders: ["venice"],
    envLabel: "VENICE_API_KEY",
    promptMessage: "Enter Venice AI API key",
    setCredential: setVeniceApiKey,
    defaultModel: VENICE_DEFAULT_MODEL_REF,
    applyDefaultConfig: applyVeniceConfig,
    applyProviderConfig: applyVeniceProviderConfig,
    noteDefault: VENICE_DEFAULT_MODEL_REF,
    noteMessage: [
      "Venice AI provides privacy-focused inference with uncensored models.",
      "Get your API key at: https://venice.ai/settings/api",
      "Supports 'private' (fully private) and 'anonymized' (proxy) modes.",
    ].join("\n"),
    noteTitle: "Venice AI",
  },
  "opencode-zen": {
    provider: "opencode",
    profileId: "opencode:default",
    expectedProviders: ["opencode"],
    envLabel: "OPENCODE_API_KEY",
    promptMessage: "Enter OpenCode Zen API key",
    setCredential: setOpencodeZenApiKey,
    defaultModel: OPENCODE_ZEN_DEFAULT_MODEL,
    applyDefaultConfig: applyOpencodeZenConfig,
    applyProviderConfig: applyOpencodeZenProviderConfig,
    noteDefault: OPENCODE_ZEN_DEFAULT_MODEL,
    noteMessage: [
      "OpenCode Zen provides access to Claude, GPT, Gemini, and more models.",
      "Get your API key at: https://opencode.ai/auth",
      "OpenCode Zen bills per request. Check your OpenCode dashboard for details.",
    ].join("\n"),
    noteTitle: "OpenCode Zen",
  },
  "together-api-key": {
    provider: "together",
    profileId: "together:default",
    expectedProviders: ["together"],
    envLabel: "TOGETHER_API_KEY",
    promptMessage: "Enter Together AI API key",
    setCredential: setTogetherApiKey,
    defaultModel: TOGETHER_DEFAULT_MODEL_REF,
    applyDefaultConfig: applyTogetherConfig,
    applyProviderConfig: applyTogetherProviderConfig,
    noteDefault: TOGETHER_DEFAULT_MODEL_REF,
    noteMessage: [
      "Together AI provides access to leading open-source models including Llama, DeepSeek, Qwen, and more.",
      "Get your API key at: https://api.together.xyz/settings/api-keys",
    ].join("\n"),
    noteTitle: "Together AI",
  },
  "qianfan-api-key": {
    provider: "qianfan",
    profileId: "qianfan:default",
    expectedProviders: ["qianfan"],
    envLabel: "QIANFAN_API_KEY",
    promptMessage: "Enter QIANFAN API key",
    setCredential: setQianfanApiKey,
    defaultModel: QIANFAN_DEFAULT_MODEL_REF,
    applyDefaultConfig: applyQianfanConfig,
    applyProviderConfig: applyQianfanProviderConfig,
    noteDefault: QIANFAN_DEFAULT_MODEL_REF,
    noteMessage: [
      "Get your API key at: https://console.bce.baidu.com/qianfan/ais/console/apiKey",
      "API key format: bce-v3/ALTAK-...",
    ].join("\n"),
    noteTitle: "QIANFAN",
  },
  "kilocode-api-key": {
    provider: "kilocode",
    profileId: "kilocode:default",
    expectedProviders: ["kilocode"],
    envLabel: "KILOCODE_API_KEY",
    promptMessage: "Enter Kilo Gateway API key",
    setCredential: setKilocodeApiKey,
    defaultModel: KILOCODE_DEFAULT_MODEL_REF,
    applyDefaultConfig: applyKilocodeConfig,
    applyProviderConfig: applyKilocodeProviderConfig,
    noteDefault: KILOCODE_DEFAULT_MODEL_REF,
  },
  "synthetic-api-key": {
    provider: "synthetic",
    profileId: "synthetic:default",
    expectedProviders: ["synthetic"],
    envLabel: "SYNTHETIC_API_KEY",
    promptMessage: "Enter Synthetic API key",
    setCredential: setSyntheticApiKey,
    defaultModel: SYNTHETIC_DEFAULT_MODEL_REF,
    applyDefaultConfig: applySyntheticConfig,
    applyProviderConfig: applySyntheticProviderConfig,
    normalize: (value) => String(value ?? "").trim(),
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  },
};

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

  let authChoice = params.authChoice;
  const normalizedTokenProvider = normalizeTokenProviderInput(params.opts?.tokenProvider);
  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
  if (authChoice === "apiKey" && params.opts?.tokenProvider) {
    if (normalizedTokenProvider !== "anthropic" && normalizedTokenProvider !== "openai") {
      authChoice = API_KEY_TOKEN_PROVIDER_AUTH_CHOICE[normalizedTokenProvider ?? ""] ?? authChoice;
    }
  }

  async function applyApiKeyProviderWithDefaultModel({
    provider,
    profileId,
    expectedProviders,
    envLabel,
    promptMessage,
    setCredential,
    defaultModel,
    applyDefaultConfig,
    applyProviderConfig,
    noteMessage,
    noteTitle,
    tokenProvider = normalizedTokenProvider,
    normalize = normalizeApiKeyInput,
    validate = validateApiKeyInput,
    noteDefault = defaultModel,
  }: {
    provider: Parameters<typeof ensureApiKeyFromOptionEnvOrPrompt>[0]["provider"];
    profileId: string;
    expectedProviders: string[];
    envLabel: string;
    promptMessage: string;
    setCredential: (apiKey: SecretInput, mode?: SecretInputMode) => void | Promise<void>;
    defaultModel: string;
    applyDefaultConfig: (
      config: ApplyAuthChoiceParams["config"],
    ) => ApplyAuthChoiceParams["config"];
    applyProviderConfig: (
      config: ApplyAuthChoiceParams["config"],
    ) => ApplyAuthChoiceParams["config"];
    noteMessage?: string;
    noteTitle?: string;
    tokenProvider?: string;
    normalize?: (value: string) => string;
    validate?: (value: string) => string | undefined;
    noteDefault?: string;
  }): Promise<ApplyAuthChoiceResult> {
    await ensureApiKeyFromOptionEnvOrPrompt({
      token: params.opts?.token,
      provider,
      tokenProvider,
      secretInputMode: requestedSecretInputMode,
      config: nextConfig,
      expectedProviders,
      envLabel,
      promptMessage,
      setCredential: async (apiKey, mode) => {
        await setCredential(apiKey, mode);
      },
      noteMessage,
      noteTitle,
      normalize,
      validate,
      prompter: params.prompter,
    });

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId,
      provider,
      mode: "api_key",
    });
    await applyProviderDefaultModel({
      defaultModel,
      applyDefaultConfig,
      applyProviderConfig,
      noteDefault,
    });

    return { config: nextConfig, agentModelOverride };
  }

  if (authChoice === "openrouter-api-key") {
    return applyAuthChoiceOpenRouter(params);
  }

  if (authChoice === "litellm-api-key") {
    const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
    const profileOrder = resolveAuthProfileOrder({ cfg: nextConfig, store, provider: "litellm" });
    const existingProfileId = profileOrder.find((profileId) => Boolean(store.profiles[profileId]));
    const existingCred = existingProfileId ? store.profiles[existingProfileId] : undefined;
    let profileId = "litellm:default";
    let hasCredential = Boolean(existingProfileId && existingCred?.type === "api_key");
    if (hasCredential && existingProfileId) {
      profileId = existingProfileId;
    }

    if (!hasCredential) {
      await ensureApiKeyFromOptionEnvOrPrompt({
        token: params.opts?.token,
        tokenProvider: normalizedTokenProvider,
        secretInputMode: requestedSecretInputMode,
        config: nextConfig,
        expectedProviders: ["litellm"],
        provider: "litellm",
        envLabel: "LITELLM_API_KEY",
        promptMessage: "Enter LiteLLM API key",
        normalize: normalizeApiKeyInput,
        validate: validateApiKeyInput,
        prompter: params.prompter,
        setCredential: async (apiKey, mode) =>
          setLitellmApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
        noteMessage:
          "LiteLLM provides a unified API to 100+ LLM providers.\nGet your API key from your LiteLLM proxy or https://litellm.ai\nDefault proxy runs on http://localhost:4000",
        noteTitle: "LiteLLM",
      });
      hasCredential = true;
    }

    if (hasCredential) {
      nextConfig = applyAuthProfileConfig(nextConfig, {
        profileId,
        provider: "litellm",
        mode: "api_key",
      });
    }
    await applyProviderDefaultModel({
      defaultModel: LITELLM_DEFAULT_MODEL_REF,
      applyDefaultConfig: applyLitellmConfig,
      applyProviderConfig: applyLitellmProviderConfig,
      noteDefault: LITELLM_DEFAULT_MODEL_REF,
    });
    return { config: nextConfig, agentModelOverride };
  }

  const simpleApiKeyProviderFlow = SIMPLE_API_KEY_PROVIDER_FLOWS[authChoice];
  if (simpleApiKeyProviderFlow) {
    return await applyApiKeyProviderWithDefaultModel({
      provider: simpleApiKeyProviderFlow.provider,
      profileId: simpleApiKeyProviderFlow.profileId,
      expectedProviders: simpleApiKeyProviderFlow.expectedProviders,
      envLabel: simpleApiKeyProviderFlow.envLabel,
      promptMessage: simpleApiKeyProviderFlow.promptMessage,
      setCredential: async (apiKey, mode) =>
        simpleApiKeyProviderFlow.setCredential(apiKey, params.agentDir, {
          secretInputMode: mode ?? requestedSecretInputMode,
        }),
      defaultModel: simpleApiKeyProviderFlow.defaultModel,
      applyDefaultConfig: simpleApiKeyProviderFlow.applyDefaultConfig,
      applyProviderConfig: simpleApiKeyProviderFlow.applyProviderConfig,
      noteDefault: simpleApiKeyProviderFlow.noteDefault,
      noteMessage: simpleApiKeyProviderFlow.noteMessage,
      noteTitle: simpleApiKeyProviderFlow.noteTitle,
      tokenProvider: simpleApiKeyProviderFlow.tokenProvider,
      normalize: simpleApiKeyProviderFlow.normalize,
      validate: simpleApiKeyProviderFlow.validate,
    });
  }

  if (authChoice === "aiping-api-key") {
    await ensureApiKeyFromOptionEnvOrPrompt({
      token: params.opts?.token,
      provider: "aiping",
      tokenProvider: normalizedTokenProvider,
      secretInputMode: requestedSecretInputMode,
      config: nextConfig,
      expectedProviders: ["aiping"],
      envLabel: "AIPING_API_KEY",
      promptMessage: "Enter AIPing API key",
      setCredential: async (apiKey, mode) =>
        setAipingApiKey(apiKey, params.agentDir, {
          secretInputMode: mode ?? requestedSecretInputMode,
        }),
      normalize: normalizeApiKeyInput,
      validate: validateApiKeyInput,
      prompter: params.prompter,
    });

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "aiping:default",
      provider: "aiping",
      mode: "api_key",
    });

    const routingSelection = await resolveAipingRoutingPreset({
      authChoice: params.authChoice,
      normalizedTokenProvider,
      token: params.opts?.token,
      prompter: params.prompter,
    });
    await applyProviderDefaultModel({
      defaultModel: routingSelection.modelRef,
      applyDefaultConfig: (config) =>
        applyPrimaryModel(
          applyAipingProviderConfigForModel(config, routingSelection),
          routingSelection.modelRef,
        ),
      applyProviderConfig: (config) => applyAipingProviderConfigForModel(config, routingSelection),
      noteDefault: routingSelection.modelRef,
    });

    return { config: nextConfig, agentModelOverride };
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

    // zai-api-key: auto-detect endpoint + choose a working default model.
    let modelIdOverride: string | undefined;
    if (!endpoint) {
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

  return null;
}
