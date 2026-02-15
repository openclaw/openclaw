import type { OpenClawConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { buildModelAliasIndex, modelKey } from "../agents/model-selection.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import { applyPrimaryModel } from "./model-picker.js";
import { normalizeAlias } from "./models/shared.js";

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_CONTEXT_WINDOW = 4096;
const DEFAULT_MAX_TOKENS = 4096;
const VERIFY_TIMEOUT_MS = 10000;

export type CustomApiCompatibility = "openai" | "anthropic";
type CustomApiCompatibilityChoice = CustomApiCompatibility | "unknown";
export type CustomApiResult = {
  config: OpenClawConfig;
  providerId?: string;
  modelId?: string;
  providerIdRenamedFrom?: string;
};

export type ApplyCustomApiConfigParams = {
  config: OpenClawConfig;
  baseUrl: string;
  modelId: string;
  compatibility: CustomApiCompatibility;
  apiKey?: string;
  providerId?: string;
  alias?: string;
};

export type ParseNonInteractiveCustomApiFlagsParams = {
  baseUrl?: string;
  modelId?: string;
  compatibility?: string;
  apiKey?: string;
  providerId?: string;
};

export type ParsedNonInteractiveCustomApiFlags = {
  baseUrl: string;
  modelId: string;
  compatibility: CustomApiCompatibility;
  apiKey?: string;
  providerId?: string;
};

export type CustomApiErrorCode =
  | "missing_required"
  | "invalid_compatibility"
  | "invalid_base_url"
  | "invalid_model_id"
  | "invalid_provider_id"
  | "invalid_alias";

export class CustomApiError extends Error {
  readonly code: CustomApiErrorCode;

  constructor(code: CustomApiErrorCode, message: string) {
    super(message);
    this.name = "CustomApiError";
    this.code = code;
  }
}

export type ResolveCustomProviderIdParams = {
  config: OpenClawConfig;
  baseUrl: string;
  providerId?: string;
};

export type ResolvedCustomProviderId = {
  providerId: string;
  providerIdRenamedFrom?: string;
};

const COMPATIBILITY_OPTIONS: Array<{
  value: CustomApiCompatibilityChoice;
  label: string;
  hint: string;
}> = [
  {
    value: "openai",
    label: "OpenAI-compatible",
    hint: "Uses /chat/completions",
  },
  {
    value: "anthropic",
    label: "Anthropic-compatible",
    hint: "Uses /messages",
  },
  {
    value: "unknown",
    label: "Unknown (detect automatically)",
    hint: "Probes OpenAI then Anthropic endpoints",
  },
];

function normalizeEndpointId(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

function buildEndpointIdFromUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const port = url.port ? `-${url.port}` : "";
    const candidate = `custom-${host}${port}`;
    return normalizeEndpointId(candidate) || "custom";
  } catch {
    return "custom";
  }
}

function resolveUniqueEndpointId(params: {
  requestedId: string;
  baseUrl: string;
  providers: Record<string, ModelProviderConfig | undefined>;
}) {
  const normalized = normalizeEndpointId(params.requestedId) || "custom";
  const existing = params.providers[normalized];
  if (!existing?.baseUrl || existing.baseUrl === params.baseUrl) {
    return { providerId: normalized, renamed: false };
  }
  let suffix = 2;
  let candidate = `${normalized}-${suffix}`;
  while (params.providers[candidate]) {
    suffix += 1;
    candidate = `${normalized}-${suffix}`;
  }
  return { providerId: candidate, renamed: true };
}

function resolveAliasError(params: {
  raw: string;
  cfg: OpenClawConfig;
  modelRef: string;
}): string | undefined {
  const trimmed = params.raw.trim();
  if (!trimmed) {
    return undefined;
  }
  let normalized: string;
  try {
    normalized = normalizeAlias(trimmed);
  } catch (err) {
    return err instanceof Error ? err.message : "Alias is invalid.";
  }
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const aliasKey = normalized.toLowerCase();
  const existing = aliasIndex.byAlias.get(aliasKey);
  if (!existing) {
    return undefined;
  }
  const existingKey = modelKey(existing.ref.provider, existing.ref.model);
  if (existingKey === params.modelRef) {
    return undefined;
  }
  return `Alias ${normalized} already points to ${existingKey}.`;
}

function buildOpenAiHeaders(apiKey: string) {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function buildAnthropicHeaders(apiKey: string) {
  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
  };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }
  return headers;
}

function formatVerificationError(error: unknown): string {
  if (!error) {
    return "unknown error";
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

type VerificationResult = {
  ok: boolean;
  status?: number;
  error?: unknown;
};

async function requestOpenAiVerification(params: {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}): Promise<VerificationResult> {
  const endpoint = new URL(
    "chat/completions",
    params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`,
  ).href;
  try {
    const res = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildOpenAiHeaders(params.apiKey),
        },
        body: JSON.stringify({
          model: params.modelId,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 5,
        }),
      },
      VERIFY_TIMEOUT_MS,
    );
    return { ok: res.ok, status: res.status };
  } catch (error) {
    return { ok: false, error };
  }
}

async function requestAnthropicVerification(params: {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}): Promise<VerificationResult> {
  const endpoint = new URL(
    "messages",
    params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`,
  ).href;
  try {
    const res = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAnthropicHeaders(params.apiKey),
        },
        body: JSON.stringify({
          model: params.modelId,
          max_tokens: 16,
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
      VERIFY_TIMEOUT_MS,
    );
    return { ok: res.ok, status: res.status };
  } catch (error) {
    return { ok: false, error };
  }
}

async function promptBaseUrlAndKey(params: {
  prompter: WizardPrompter;
  initialBaseUrl?: string;
}): Promise<{ baseUrl: string; apiKey: string }> {
  const baseUrlInput = await params.prompter.text({
    message: "API Base URL",
    initialValue: params.initialBaseUrl ?? DEFAULT_OLLAMA_BASE_URL,
    placeholder: "https://api.example.com/v1",
    validate: (val) => {
      try {
        new URL(val);
        return undefined;
      } catch {
        return "Please enter a valid URL (e.g. http://...)";
      }
    },
  });
  const apiKeyInput = await params.prompter.text({
    message: "API Key (leave blank if not required)",
    placeholder: "sk-...",
    initialValue: "",
  });
  return { baseUrl: baseUrlInput.trim(), apiKey: apiKeyInput.trim() };
}

type CustomApiRetryChoice = "baseUrl" | "model" | "both";

async function promptCustomApiRetryChoice(prompter: WizardPrompter): Promise<CustomApiRetryChoice> {
  return await prompter.select({
    message: "What would you like to change?",
    options: [
      { value: "baseUrl", label: "Change base URL" },
      { value: "model", label: "Change model" },
      { value: "both", label: "Change base URL and model" },
    ],
  });
}

async function promptCustomApiModelId(prompter: WizardPrompter): Promise<string> {
  return (
    await prompter.text({
      message: "Model ID",
      placeholder: "e.g. llama3, claude-3-7-sonnet",
      validate: (val) => (val.trim() ? undefined : "Model ID is required"),
    })
  ).trim();
}

function resolveProviderApi(
  compatibility: CustomApiCompatibility,
): "openai-completions" | "anthropic-messages" {
  return compatibility === "anthropic" ? "anthropic-messages" : "openai-completions";
}

function parseCustomApiCompatibility(raw?: string): CustomApiCompatibility {
  const compatibilityRaw = raw?.trim().toLowerCase();
  if (!compatibilityRaw) {
    return "openai";
  }
  if (compatibilityRaw !== "openai" && compatibilityRaw !== "anthropic") {
    throw new CustomApiError(
      "invalid_compatibility",
      'Invalid --custom-compatibility (use "openai" or "anthropic").',
    );
  }
  return compatibilityRaw;
}

export function resolveCustomProviderId(
  params: ResolveCustomProviderIdParams,
): ResolvedCustomProviderId {
  const providers = params.config.models?.providers ?? {};
  const baseUrl = params.baseUrl.trim();
  const explicitProviderId = params.providerId?.trim();
  if (explicitProviderId && !normalizeEndpointId(explicitProviderId)) {
    throw new CustomApiError(
      "invalid_provider_id",
      "Custom provider ID must include letters, numbers, or hyphens.",
    );
  }
  const requestedProviderId = explicitProviderId || buildEndpointIdFromUrl(baseUrl);
  const providerIdResult = resolveUniqueEndpointId({
    requestedId: requestedProviderId,
    baseUrl,
    providers,
  });

  return {
    providerId: providerIdResult.providerId,
    ...(providerIdResult.renamed
      ? {
          providerIdRenamedFrom: normalizeEndpointId(requestedProviderId) || "custom",
        }
      : {}),
  };
}

export function parseNonInteractiveCustomApiFlags(
  params: ParseNonInteractiveCustomApiFlagsParams,
): ParsedNonInteractiveCustomApiFlags {
  const baseUrl = params.baseUrl?.trim() ?? "";
  const modelId = params.modelId?.trim() ?? "";
  if (!baseUrl || !modelId) {
    throw new CustomApiError(
      "missing_required",
      [
        'Auth choice "custom-api-key" requires a base URL and model ID.',
        "Use --custom-base-url and --custom-model-id.",
      ].join("\n"),
    );
  }

  const apiKey = params.apiKey?.trim();
  const providerId = params.providerId?.trim();
  if (providerId && !normalizeEndpointId(providerId)) {
    throw new CustomApiError(
      "invalid_provider_id",
      "Custom provider ID must include letters, numbers, or hyphens.",
    );
  }
  return {
    baseUrl,
    modelId,
    compatibility: parseCustomApiCompatibility(params.compatibility),
    ...(apiKey ? { apiKey } : {}),
    ...(providerId ? { providerId } : {}),
  };
}

export function applyCustomApiConfig(params: ApplyCustomApiConfigParams): CustomApiResult {
  const baseUrl = params.baseUrl.trim();
  try {
    new URL(baseUrl);
  } catch {
    throw new CustomApiError("invalid_base_url", "Custom provider base URL must be a valid URL.");
  }

  if (params.compatibility !== "openai" && params.compatibility !== "anthropic") {
    throw new CustomApiError(
      "invalid_compatibility",
      'Custom provider compatibility must be "openai" or "anthropic".',
    );
  }

  const modelId = params.modelId.trim();
  if (!modelId) {
    throw new CustomApiError("invalid_model_id", "Custom provider model ID is required.");
  }

  const providerIdResult = resolveCustomProviderId({
    config: params.config,
    baseUrl,
    providerId: params.providerId,
  });
  const providerId = providerIdResult.providerId;
  const providers = params.config.models?.providers ?? {};

  const modelRef = modelKey(providerId, modelId);
  const alias = params.alias?.trim() ?? "";
  const aliasError = resolveAliasError({
    raw: alias,
    cfg: params.config,
    modelRef,
  });
  if (aliasError) {
    throw new CustomApiError("invalid_alias", aliasError);
  }

  const existingProvider = providers[providerId];
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const hasModel = existingModels.some((model) => model.id === modelId);
  const nextModel = {
    id: modelId,
    name: `${modelId} (Custom Provider)`,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    input: ["text"] as ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
  };
  const mergedModels = hasModel ? existingModels : [...existingModels, nextModel];
  const { apiKey: existingApiKey, ...existingProviderRest } = existingProvider ?? {};
  const normalizedApiKey =
    params.apiKey?.trim() || (existingApiKey ? existingApiKey.trim() : undefined);

  let config: OpenClawConfig = {
    ...params.config,
    models: {
      ...params.config.models,
      mode: params.config.models?.mode ?? "merge",
      providers: {
        ...providers,
        [providerId]: {
          ...existingProviderRest,
          baseUrl,
          api: resolveProviderApi(params.compatibility),
          ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
          models: mergedModels.length > 0 ? mergedModels : [nextModel],
        },
      },
    },
  };

  config = applyPrimaryModel(config, modelRef);
  if (alias) {
    config = {
      ...config,
      agents: {
        ...config.agents,
        defaults: {
          ...config.agents?.defaults,
          models: {
            ...config.agents?.defaults?.models,
            [modelRef]: {
              ...config.agents?.defaults?.models?.[modelRef],
              alias,
            },
          },
        },
      },
    };
  }

  return {
    config,
    providerId,
    modelId,
    ...(providerIdResult.providerIdRenamedFrom
      ? { providerIdRenamedFrom: providerIdResult.providerIdRenamedFrom }
      : {}),
  };
}

export async function promptCustomApiConfig(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  config: OpenClawConfig;
}): Promise<CustomApiResult> {
  const { prompter, runtime, config } = params;

  const baseInput = await promptBaseUrlAndKey({ prompter });
  let baseUrl = baseInput.baseUrl;
  let apiKey = baseInput.apiKey;

  const compatibilityChoice = await prompter.select({
    message: "Endpoint compatibility",
    options: COMPATIBILITY_OPTIONS.map((option) => ({
      value: option.value,
      label: option.label,
      hint: option.hint,
    })),
  });

  let modelId = await promptCustomApiModelId(prompter);

  let compatibility: CustomApiCompatibility | null =
    compatibilityChoice === "unknown" ? null : compatibilityChoice;

  while (true) {
    let verifiedFromProbe = false;
    if (!compatibility) {
      const probeSpinner = prompter.progress("Detecting endpoint type...");
      const openaiProbe = await requestOpenAiVerification({ baseUrl, apiKey, modelId });
      if (openaiProbe.ok) {
        probeSpinner.stop("Detected OpenAI-compatible endpoint.");
        compatibility = "openai";
        verifiedFromProbe = true;
      } else {
        const anthropicProbe = await requestAnthropicVerification({ baseUrl, apiKey, modelId });
        if (anthropicProbe.ok) {
          probeSpinner.stop("Detected Anthropic-compatible endpoint.");
          compatibility = "anthropic";
          verifiedFromProbe = true;
        } else {
          probeSpinner.stop("Could not detect endpoint type.");
          await prompter.note(
            "This endpoint did not respond to OpenAI or Anthropic style requests.",
            "Endpoint detection",
          );
          const retryChoice = await promptCustomApiRetryChoice(prompter);
          if (retryChoice === "baseUrl" || retryChoice === "both") {
            const retryInput = await promptBaseUrlAndKey({
              prompter,
              initialBaseUrl: baseUrl,
            });
            baseUrl = retryInput.baseUrl;
            apiKey = retryInput.apiKey;
          }
          if (retryChoice === "model" || retryChoice === "both") {
            modelId = await promptCustomApiModelId(prompter);
          }
          continue;
        }
      }
    }

    if (verifiedFromProbe) {
      break;
    }

    const verifySpinner = prompter.progress("Verifying...");
    const result =
      compatibility === "anthropic"
        ? await requestAnthropicVerification({ baseUrl, apiKey, modelId })
        : await requestOpenAiVerification({ baseUrl, apiKey, modelId });
    if (result.ok) {
      verifySpinner.stop("Verification successful.");
      break;
    }
    if (result.status !== undefined) {
      verifySpinner.stop(`Verification failed: status ${result.status}`);
    } else {
      verifySpinner.stop(`Verification failed: ${formatVerificationError(result.error)}`);
    }
    const retryChoice = await promptCustomApiRetryChoice(prompter);
    if (retryChoice === "baseUrl" || retryChoice === "both") {
      const retryInput = await promptBaseUrlAndKey({
        prompter,
        initialBaseUrl: baseUrl,
      });
      baseUrl = retryInput.baseUrl;
      apiKey = retryInput.apiKey;
    }
    if (retryChoice === "model" || retryChoice === "both") {
      modelId = await promptCustomApiModelId(prompter);
    }
    if (compatibilityChoice === "unknown") {
      compatibility = null;
    }
  }

  const providers = config.models?.providers ?? {};
  const suggestedId = buildEndpointIdFromUrl(baseUrl);
  const providerIdInput = await prompter.text({
    message: "Endpoint ID",
    initialValue: suggestedId,
    placeholder: "custom",
    validate: (value) => {
      const normalized = normalizeEndpointId(value);
      if (!normalized) {
        return "Endpoint ID is required.";
      }
      return undefined;
    },
  });
  const aliasInput = await prompter.text({
    message: "Model alias (optional)",
    placeholder: "e.g. local, ollama",
    initialValue: "",
    validate: (value) => {
      const requestedId = normalizeEndpointId(providerIdInput) || "custom";
      const providerIdResult = resolveUniqueEndpointId({
        requestedId,
        baseUrl,
        providers,
      });
      const modelRef = modelKey(providerIdResult.providerId, modelId);
      return resolveAliasError({ raw: value, cfg: config, modelRef });
    },
  });
  const resolvedCompatibility = compatibility ?? "openai";
  const result = applyCustomApiConfig({
    config,
    baseUrl,
    modelId,
    compatibility: resolvedCompatibility,
    apiKey,
    providerId: providerIdInput,
    alias: aliasInput,
  });

  if (result.providerIdRenamedFrom && result.providerId) {
    await prompter.note(
      `Endpoint ID "${result.providerIdRenamedFrom}" already exists for a different base URL. Using "${result.providerId}".`,
      "Endpoint ID",
    );
  }

  runtime.log(`Configured custom provider: ${result.providerId}/${result.modelId}`);
  return result;
}
