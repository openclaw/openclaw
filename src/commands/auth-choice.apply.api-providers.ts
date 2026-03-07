import http from "node:http";
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
import type { ApiKeyStorageOptions } from "./onboard-auth.credentials.js";
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
  applyMistralConfig,
  applyMistralProviderConfig,
  applyMoonshotConfig,
  applyMoonshotConfigCn,
  applyMoonshotProviderConfig,
  applyMoonshotProviderConfigCn,
  applyOpencodeZenConfig,
  applyOpencodeZenProviderConfig,
  applyPuterConfig,
  applyPuterProviderConfig,
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
  PUTER_DEFAULT_MODEL_ID,
  MISTRAL_DEFAULT_MODEL_REF,
  SYNTHETIC_DEFAULT_MODEL_REF,
  TOGETHER_DEFAULT_MODEL_REF,
  VENICE_DEFAULT_MODEL_REF,
  VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
  XIAOMI_DEFAULT_MODEL_REF,
  setCloudflareAiGatewayConfig,
  setQianfanApiKey,
  setGeminiApiKey,
  setKilocodeApiKey,
  setLitellmApiKey,
  setKimiCodingApiKey,
  setMistralApiKey,
  setMoonshotApiKey,
  setOpencodeZenApiKey,
  setPuterApiKey,
  setSyntheticApiKey,
  setTogetherApiKey,
  setVeniceApiKey,
  setVercelAiGatewayApiKey,
  setXiaomiApiKey,
  setZaiApiKey,
  ZAI_DEFAULT_MODEL_REF,
} from "./onboard-auth.js";
import { openUrl } from "./onboard-helpers.js";
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
  puter: "puter-api-key",
};

const PUTER_WEB_ORIGIN = "https://puter.com";
const PUTER_AUTH_TIMEOUT_MS = 120_000;
const PUTER_MODELS_ENDPOINT = "https://api.puter.com/puterai/chat/models";
const PUTER_MODEL_PICKER_DEFAULT = "__default__";
const PUTER_MODEL_PICKER_MANUAL = "__manual__";

async function getPuterAuthToken(params: {
  guiOrigin?: string;
  prompter: ApplyAuthChoiceParams["prompter"];
}): Promise<string | undefined> {
  const guiOrigin = params.guiOrigin?.trim() || PUTER_WEB_ORIGIN;
  return await new Promise((resolve) => {
    let finished = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (token?: string) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (server.listening) {
        server.close(() => resolve(token));
      } else {
        resolve(token);
      }
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost/");
      const token = url.searchParams.get("token")?.trim() || undefined;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Puter login complete</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#404C71;color:#1a1a2e;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif}.card{background:#fff;padding:24px 28px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.22);max-width:420px}.title{margin:0 0 8px;font-size:20px}.sub{margin:0;color:#64748b}</style></head><body><div class="card"><h1 class="title">Authentication Successful</h1><p class="sub">You may close this tab and return to your terminal.</p></div></body></html>',
      );
      finish(token);
    });

    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        finish(undefined);
        return;
      }

      timeout = setTimeout(() => finish(undefined), PUTER_AUTH_TIMEOUT_MS);
      const redirectUrl = `http://127.0.0.1:${address.port}`;
      const authUrl = `${guiOrigin}/?action=authme&redirectURL=${encodeURIComponent(redirectUrl)}`;
      const opened = await openUrl(authUrl);
      if (!opened) {
        await params.prompter.note(
          ["Open this URL to complete Puter login:", authUrl].join("\n"),
          "Puter web login",
        );
      }
    });
  });
}

function normalizePuterModelIds(models: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const model of models) {
    const trimmed = model.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function extractPuterModelId(entry: unknown): string | null {
  if (typeof entry === "string") {
    return entry.trim() || null;
  }
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const record = entry as Record<string, unknown>;
  for (const key of ["id", "model", "name"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

async function fetchPuterModelIds(apiKey?: string): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (apiKey?.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  try {
    const response = await fetch(PUTER_MODELS_ENDPOINT, {
      headers,
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as unknown;
    let entries: unknown[] = [];
    if (Array.isArray(payload)) {
      entries = payload;
    } else if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      if (Array.isArray(record.data)) {
        entries = record.data;
      } else if (Array.isArray(record.models)) {
        entries = record.models;
      }
    }
    return normalizePuterModelIds(
      entries
        .map((entry) => extractPuterModelId(entry))
        .filter((value): value is string => Boolean(value)),
    );
  } catch {
    return [];
  }
}

async function resolvePuterModelId(params: {
  apiKey?: string;
  prompter: ApplyAuthChoiceParams["prompter"];
}): Promise<string> {
  const progress = params.prompter.progress("Fetching Puter models...");
  const models = await fetchPuterModelIds(params.apiKey);
  progress.stop();

  if (models.length === 0) {
    return PUTER_DEFAULT_MODEL_ID;
  }

  const filtered = models.filter((model) => model !== PUTER_DEFAULT_MODEL_ID);
  const selection = await params.prompter.select({
    message: "Select Puter model",
    initialValue: PUTER_MODEL_PICKER_DEFAULT,
    options: [
      { value: PUTER_MODEL_PICKER_DEFAULT, label: `Default (${PUTER_DEFAULT_MODEL_ID})` },
      { value: PUTER_MODEL_PICKER_MANUAL, label: "Enter model manually" },
      ...filtered.map((model) => ({ value: model, label: model })),
    ],
  });

  if (selection === PUTER_MODEL_PICKER_DEFAULT) {
    return PUTER_DEFAULT_MODEL_ID;
  }
  if (selection === PUTER_MODEL_PICKER_MANUAL) {
    const manual = await params.prompter.text({
      message: "Puter model id",
      initialValue: PUTER_DEFAULT_MODEL_ID,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    return manual.trim() || PUTER_DEFAULT_MODEL_ID;
  }
  return selection.trim() || PUTER_DEFAULT_MODEL_ID;
}

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

  if (authChoice === "puter-web" || authChoice === "puter-api-key") {
    let resolvedApiKey: string | undefined;
    if (authChoice === "puter-web") {
      const token = await getPuterAuthToken({ prompter: params.prompter });
      if (token?.trim()) {
        resolvedApiKey = normalizeApiKeyInput(token);
        await setPuterApiKey(resolvedApiKey, params.agentDir, {
          secretInputMode: requestedSecretInputMode,
        });
      } else {
        await params.prompter.note(
          "Puter web login did not return a token. Falling back to API key entry.",
          "Puter web login",
        );
      }
    }
    if (!resolvedApiKey) {
      resolvedApiKey = await ensureApiKeyFromOptionEnvOrPrompt({
        token: params.opts?.token,
        provider: "puter",
        tokenProvider: normalizedTokenProvider,
        secretInputMode: requestedSecretInputMode,
        config: nextConfig,
        expectedProviders: ["puter"],
        envLabel: "PUTER_API_KEY",
        promptMessage: "Enter Puter API key (https://puter.com/?action=copyauth)",
        normalize: normalizeApiKeyInput,
        validate: validateApiKeyInput,
        prompter: params.prompter,
        setCredential: async (apiKey, mode) =>
          setPuterApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
      });
    }

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "puter:default",
      provider: "puter",
      mode: "api_key",
    });
    const puterModelId = await resolvePuterModelId({
      apiKey: resolvedApiKey,
      prompter: params.prompter,
    });
    const puterModelRef = `puter/${puterModelId}`;
    await applyProviderDefaultModel({
      defaultModel: puterModelRef,
      applyDefaultConfig: (config) => applyPuterConfig(config, puterModelId),
      applyProviderConfig: (config) => applyPuterProviderConfig(config, puterModelId),
      noteDefault: puterModelRef,
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
