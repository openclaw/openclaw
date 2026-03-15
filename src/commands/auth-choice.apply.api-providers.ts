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
import { applyPrimaryModel } from "./model-picker.js";
import {
  AIPING_DEFAULT_MODEL_REF,
  applyAipingProviderConfig,
  applyAuthProfileConfig,
  applyCloudflareAiGatewayConfig,
  applyCloudflareAiGatewayProviderConfig,
  applyZaiConfig,
  applyZaiProviderConfig,
  CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  setAipingApiKey,
  setCloudflareAiGatewayConfig,
  setGeminiApiKey,
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
  opencode: "opencode-zen",
  "opencode-go": "opencode-go",
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
  return resolveAipingRoutingSelection(selected ?? "default");
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

  let authChoice = params.authChoice;
  const normalizedTokenProvider = normalizeTokenProviderInput(params.opts?.tokenProvider);
  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
  if (authChoice === "apiKey" && params.opts?.tokenProvider) {
    if (normalizedTokenProvider !== "anthropic" && normalizedTokenProvider !== "openai") {
      authChoice = API_KEY_TOKEN_PROVIDER_AUTH_CHOICE[normalizedTokenProvider ?? ""] ?? authChoice;
    }
  }

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

  return null;
}
