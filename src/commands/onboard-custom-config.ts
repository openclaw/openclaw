import { isHttpUrl } from "@openclaw/net-policy/url-protocol";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { CONTEXT_WINDOW_HARD_MIN_TOKENS } from "../agents/context-window-guard.js";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { normalizeConfiguredProviderCatalogModelId } from "../agents/model-ref-shared.js";
import { buildModelAliasIndex, modelKey, type ModelRef } from "../agents/model-selection.js";
import { normalizeAgentModelRefForConfig } from "../config/model-input.js";
import type { ModelApi } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretRef, type SecretInput } from "../config/types.secrets.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { applyPrimaryModel } from "../plugins/provider-model-primary.js";
import { materializeSecretInput } from "../secrets/resolve-secret-input-string.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import { normalizeAlias } from "./models/alias-name.js";
import { applyAgentModelDefaults, type OnboardingAgentTarget } from "./onboard-agent-target.js";

/**
 * Wizard default for non-Azure custom APIs when context length is unknown.
 * Mirrors the generic persisted custom-model catalog fallback and leaves enough
 * room above the default compaction reserve floor in `agent-settings.ts`.
 */
const CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_MAX_TOKENS = 4096;
// Azure OpenAI uses the Responses API, which supports larger generated defaults.
const AZURE_DEFAULT_CONTEXT_WINDOW = 400_000;
const AZURE_DEFAULT_MAX_TOKENS = 16_384;
type CustomModelInput = "text" | "image";
type CustomAliasManifestPlugin = Pick<PluginManifestRecord, "modelIdNormalization">;

type CustomModelImageInputInference = {
  supportsImageInput: boolean;
  confidence: "known" | "unknown";
};

function normalizeContextWindowForCustomModel(value: unknown): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  // The hard minimum is a guardrail sentinel, not a useful custom model window.
  return parsed > CONTEXT_WINDOW_HARD_MIN_TOKENS
    ? parsed
    : CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW_TOKENS;
}

function customModelInputs(supportsImageInput: boolean): CustomModelInput[] {
  return supportsImageInput ? ["text", "image"] : ["text"];
}

export function resolveCustomModelImageInputInference(
  modelId: string,
): CustomModelImageInputInference {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  if (!normalized) {
    return { supportsImageInput: false, confidence: "unknown" };
  }
  const matchesKnownVision =
    /\b(?:gpt-4o|gpt-4\.1|gpt-[5-9]|o[134])\b/.test(normalized) ||
    /\bclaude-(?:3|4|sonnet|opus|haiku)\b/.test(normalized) ||
    /\bgemini\b/.test(normalized) ||
    /\b(?:qwen[\w.-]*-?vl|qwen-vl)\b/.test(normalized) ||
    /\b(?:vision|llava|pixtral|internvl|mllama|minicpm-v|glm-4v)\b/.test(normalized) ||
    /(?:^|[-_/])vl(?:[-_/]|$)/.test(normalized);
  const knownModel =
    matchesKnownVision ||
    /\b(?:llama\d*|deepseek|mistral|mixtral|kimi|moonshot|codestral|devstral|phi|qwq|codellama)\b/.test(
      normalized,
    ) ||
    /\bqwen(?!.*(?:vl|vision))/.test(normalized);
  return { supportsImageInput: matchesKnownVision, confidence: knownModel ? "known" : "unknown" };
}

function isAzureUrl(baseUrl: string, openAiOnly = false): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host.endsWith(".openai.azure.com") || (!openAiOnly && host.endsWith(".services.ai.azure.com"))
    );
  } catch {
    return false;
  }
}

function transformAzureUrl(baseUrl: string, modelId: string): string {
  const normalizedUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  if (normalizedUrl.includes("/openai/deployments/")) {
    return normalizedUrl;
  }
  return `${normalizedUrl}/openai/deployments/${modelId}`;
}

function transformAzureConfigUrl(baseUrl: string): string {
  const normalizedUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  if (normalizedUrl.endsWith("/openai/v1")) {
    return normalizedUrl;
  }
  const deploymentIdx = normalizedUrl.indexOf("/openai/deployments/");
  const base = deploymentIdx !== -1 ? normalizedUrl.slice(0, deploymentIdx) : normalizedUrl;
  return `${base}/openai/v1`;
}

function hasSameHost(a: string, b: string): boolean {
  try {
    return (
      normalizeLowercaseStringOrEmpty(new URL(a).hostname) ===
      normalizeLowercaseStringOrEmpty(new URL(b).hostname)
    );
  } catch {
    return false;
  }
}

export type CustomApiCompatibility = "openai" | "openai-responses" | "anthropic";

export function resolveCustomProviderApi(params: {
  baseUrl: string;
  compatibility: CustomApiCompatibility;
  modelApi?: ModelApi;
}): ModelApi {
  return (
    params.modelApi ??
    (isAzureUrl(params.baseUrl, true)
      ? "azure-openai-responses"
      : params.compatibility === "anthropic"
        ? "anthropic-messages"
        : params.compatibility === "openai-responses"
          ? "openai-responses"
          : "openai-completions")
  );
}

export type CustomApiResult = ReturnType<typeof applyCustomApiConfig>;

type ApplyCustomApiConfigParams = {
  config: OpenClawConfig;
  baseUrl: string;
  modelId: string;
  modelIds?: string[];
  compatibility: CustomApiCompatibility;
  apiKey?: SecretInput;
  /** Explicitly mark the endpoint as not enforcing auth (`auth: "none"`). */
  noAuth?: boolean;
  providerId?: string;
  alias?: string;
  supportsImageInput?: boolean;
  /** Keep authored catalog fields when importing discovered model IDs. */
  preserveExistingModelMetadata?: boolean;
  target?: OnboardingAgentTarget;
  setAsPrimary?: boolean;
  manifestPlugins?: readonly CustomAliasManifestPlugin[];
};

type ParseNonInteractiveCustomApiFlagsParams = {
  baseUrl?: string;
  modelId?: string;
  compatibility?: string;
  apiKey?: string;
  noAuth?: boolean;
  providerId?: string;
  supportsImageInput?: boolean;
};

type CustomApiErrorCode =
  | "missing_required"
  | "invalid_compatibility"
  | "invalid_base_url"
  | "invalid_model_id"
  | "invalid_provider_id"
  | "invalid_alias"
  | "no_auth_conflict"
  | "no_auth_unsupported";

/** Error class used by callers to turn custom API validation failures into CLI UX. */
export class CustomApiError extends Error {
  readonly code: CustomApiErrorCode;

  constructor(code: CustomApiErrorCode, message: string) {
    super(message);
    this.name = "CustomApiError";
    this.code = code;
  }
}

export function normalizeEndpointId(raw: string): string {
  return normalizeLowercaseStringOrEmpty(raw)
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Builds a stable custom provider id from an endpoint URL host and port. */
export function buildEndpointIdFromUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const host = normalizeLowercaseStringOrEmpty(url.hostname.replace(/[^a-z0-9]+/gi, "-"));
    const port = url.port ? `-${url.port}` : "";
    const candidate = `custom-${host}${port}`;
    return normalizeEndpointId(candidate) || "custom";
  } catch {
    return "custom";
  }
}

function configuredAliasModelKey(
  ref: ModelRef,
  manifestPlugins: readonly CustomAliasManifestPlugin[],
): string {
  return modelKey(
    ref.provider,
    normalizeConfiguredProviderCatalogModelId(ref.provider, ref.model, { manifestPlugins }),
  );
}

export function resolveCustomModelAliasError(params: {
  raw: string;
  cfg: OpenClawConfig;
  modelRef: ModelRef;
  manifestPlugins: readonly CustomAliasManifestPlugin[];
  agentId?: string;
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
    agentId: params.agentId,
    manifestPlugins: params.manifestPlugins,
    allowPluginNormalization: false,
  });
  const aliasKey = normalizeLowercaseStringOrEmpty(normalized);
  const existing = aliasIndex.byAlias.get(aliasKey);
  if (!existing) {
    return undefined;
  }
  const existingKey = modelKey(existing.ref.provider, existing.ref.model);
  if (
    configuredAliasModelKey(existing.ref, params.manifestPlugins) ===
    configuredAliasModelKey(params.modelRef, params.manifestPlugins)
  ) {
    return undefined;
  }
  return `Alias ${normalized} already points to ${existingKey}.`;
}

type VerificationRequest = {
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

/** Normalizes optional provider API key input while preserving secret refs. */
export function normalizeOptionalProviderApiKey(value: unknown): SecretInput | undefined {
  if (isSecretRef(value)) {
    return value;
  }
  return normalizeOptionalSecretInput(value);
}

function resolveVerificationEndpoint(params: {
  baseUrl: string;
  modelId: string;
  endpointPath: "chat/completions" | "messages";
}) {
  const resolvedUrl = isAzureUrl(params.baseUrl)
    ? transformAzureUrl(params.baseUrl, params.modelId)
    : params.baseUrl;
  const endpointUrl = new URL(
    params.endpointPath,
    resolvedUrl.endsWith("/") ? resolvedUrl : `${resolvedUrl}/`,
  );
  if (isAzureUrl(params.baseUrl)) {
    // Azure deployment probes need a concrete api-version; stored config keeps
    // only the reusable base URL and lets the runtime client own request paths.
    endpointUrl.searchParams.set("api-version", "2024-10-21");
  }
  return endpointUrl.href;
}

/** Builds a minimal OpenAI-family request used only to verify custom endpoints. */
export function buildOpenAiVerificationProbeRequest(params: {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  responsesApi?: boolean;
}): VerificationRequest {
  const isBaseUrlAzureUrl = isAzureUrl(params.baseUrl);
  const headers: Record<string, string> = params.apiKey
    ? isBaseUrlAzureUrl
      ? { "api-key": params.apiKey }
      : { Authorization: `Bearer ${params.apiKey}` }
    : {};
  const responsesApi = isAzureUrl(params.baseUrl, true) || params.responsesApi === true;
  const endpoint = responsesApi
    ? new URL(
        "responses",
        (isBaseUrlAzureUrl ? transformAzureConfigUrl(params.baseUrl) : params.baseUrl).replace(
          /\/?$/,
          "/",
        ),
      ).href
    : resolveVerificationEndpoint({
        baseUrl: params.baseUrl,
        modelId: params.modelId,
        endpointPath: "chat/completions",
      });
  return {
    endpoint,
    headers,
    body: {
      model: params.modelId,
      // Recent OpenAI-family endpoints reject probes below 16 tokens.
      ...(responsesApi
        ? { input: "Hi", max_output_tokens: 16 }
        : { messages: [{ role: "user", content: "Hi" }], max_tokens: 16 }),
      stream: false,
    },
  };
}

/** Builds a minimal Anthropic-compatible request used only to verify endpoints. */
export function buildAnthropicVerificationProbeRequest(params: {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}): VerificationRequest {
  // Use a base URL with /v1 injected for this raw fetch only. The rest of the app uses the
  // Anthropic client, which appends /v1 itself; config should store the base URL
  // without /v1 to avoid /v1/v1/messages at runtime. See docs/gateway/configuration-reference.md.
  const baseUrlForRequest = /\/v1\/?$/.test(params.baseUrl.trim())
    ? params.baseUrl.trim()
    : params.baseUrl.trim().replace(/\/?$/, "") + "/v1";
  const endpoint = resolveVerificationEndpoint({
    baseUrl: baseUrlForRequest,
    modelId: params.modelId,
    endpointPath: "messages",
  });
  return {
    endpoint,
    headers: {
      "anthropic-version": "2023-06-01",
      ...(params.apiKey ? { "x-api-key": params.apiKey } : {}),
    },
    body: {
      model: params.modelId,
      max_tokens: 1,
      messages: [{ role: "user", content: "Hi" }],
      stream: false,
    },
  };
}

function isCustomApiCompatibility(value: string): value is CustomApiCompatibility {
  return value === "openai" || value === "openai-responses" || value === "anthropic";
}

function parseCustomApiCompatibility(raw?: string): CustomApiCompatibility {
  const compatibilityRaw = normalizeOptionalLowercaseString(raw);
  if (!compatibilityRaw) {
    return "openai";
  }
  if (!isCustomApiCompatibility(compatibilityRaw)) {
    throw new CustomApiError(
      "invalid_compatibility",
      'Invalid --custom-compatibility (use "openai", "openai-responses", or "anthropic").',
    );
  }
  return compatibilityRaw;
}

function assertValidCustomProviderId(providerId: string | undefined): void {
  if (providerId && !normalizeEndpointId(providerId)) {
    throw new CustomApiError(
      "invalid_provider_id",
      "Custom provider ID must include letters, numbers, or hyphens.",
    );
  }
}

export function resolveCustomProviderId(params: {
  config: OpenClawConfig;
  baseUrl: string;
  providerId?: string;
}): { providerId: string; providerIdRenamedFrom?: string } {
  const providers = params.config.models?.providers ?? {};
  const baseUrl = params.baseUrl.trim();
  const explicitProviderId = params.providerId?.trim();
  assertValidCustomProviderId(explicitProviderId);
  const requestedId =
    normalizeEndpointId(explicitProviderId || buildEndpointIdFromUrl(baseUrl)) || "custom";
  const existing = providers[requestedId];
  // Azure config URLs are normalized before storage, so host equality preserves
  // the existing provider id across deployment-path and /openai/v1 variants.
  if (
    !existing?.baseUrl ||
    existing.baseUrl === baseUrl ||
    (isAzureUrl(baseUrl) && hasSameHost(existing.baseUrl, baseUrl))
  ) {
    return { providerId: requestedId };
  }
  let suffix = 2;
  while (providers[`${requestedId}-${suffix}`]) {
    suffix += 1;
  }
  return { providerId: `${requestedId}-${suffix}`, providerIdRenamedFrom: requestedId };
}

/** Preserve a matching provider's anonymous policy unless a new key replaces it. */
export function resolveCustomProviderNoAuth(params: {
  config: OpenClawConfig;
  providerId: string;
  apiKey?: string;
  noAuth?: boolean;
}): boolean {
  return (
    params.noAuth === true ||
    (!params.apiKey && params.config.models?.providers?.[params.providerId]?.auth === "none")
  );
}

/** Discovers custom endpoint ids without changing the runtime model catalog. */
export async function discoverCustomApiModelIds(params: {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}): Promise<string[]> {
  try {
    const { discoverOpenAICompatibleLocalModels } =
      await import("../plugins/provider-self-hosted-discovery.js");
    const isAzure = isAzureUrl(params.baseUrl);
    const result = await discoverOpenAICompatibleLocalModels({
      baseUrl: isAzure ? transformAzureConfigUrl(params.baseUrl) : params.baseUrl,
      apiKey: isAzure ? undefined : params.apiKey,
      headers: isAzure
        ? {
            ...buildOpenAiVerificationProbeRequest({
              baseUrl: params.baseUrl,
              apiKey: params.apiKey ?? "",
              modelId: "",
            }).headers,
            ...params.headers,
          }
        : params.headers,
      label: "custom provider",
      rawResult: true,
      discoverRuntimeContext: false,
    });
    return result.kind === "success"
      ? [
          ...new Set(
            result.rows.flatMap(({ model }) => {
              const id = normalizeOptionalString(model.id);
              return id ? [id] : [];
            }),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

export async function resolveNonInteractiveCustomApiModelIds(params: {
  config: OpenClawConfig;
  baseUrl: string;
  providerId?: string;
  modelId: string;
  apiKey?: string;
  noAuth?: boolean;
  agentDir?: string;
  modelIds?: string[];
}): Promise<string[]> {
  let modelIds = params.modelId ? [params.modelId] : params.modelIds;
  if (!modelIds) {
    const { providerId } = resolveCustomProviderId(params);
    const noAuth = resolveCustomProviderNoAuth({ ...params, providerId });
    let configuredKey = noAuth ? undefined : params.config.models?.providers?.[providerId]?.apiKey;
    const credentialError = () =>
      new CustomApiError(
        "missing_required",
        "Could not resolve the configured custom provider credential. Check its secret reference or profile, or pass --custom-api-key or --custom-model-id explicitly.",
      );
    if (!params.apiKey && typeof configuredKey === "string") {
      const [
        { loadAuthProfileStoreWithoutExternalProfilesAsync },
        { resolveProviderEntryApiKeyBinding, resolveUsableCustomProviderApiKey },
      ] = await Promise.all([
        import("../agents/auth-profiles/store-runtime.js"),
        import("../agents/model-auth-provider-config.js"),
      ]);
      const binding = await resolveProviderEntryApiKeyBinding({
        cfg: params.config,
        provider: providerId,
        store: await loadAuthProfileStoreWithoutExternalProfilesAsync(params.agentDir),
        agentDir: params.agentDir,
      });
      if (binding.kind === "profile-resolved") {
        configuredKey = binding.auth.apiKey;
      } else if (binding.kind === "profile-incompatible" || binding.kind === "profile-unresolved") {
        throw credentialError();
      } else {
        configuredKey =
          resolveUsableCustomProviderApiKey({ cfg: params.config, provider: providerId })?.apiKey ??
          configuredKey;
      }
    }
    const apiKey = noAuth
      ? undefined
      : (params.apiKey ??
        (await materializeSecretInput({
          config: params.config,
          value: configuredKey,
          env: process.env,
          onResolveRefError: () => {
            throw credentialError();
          },
        })));
    modelIds = await discoverCustomApiModelIds({ ...params, apiKey });
  }
  if (!modelIds.length) {
    throw new CustomApiError(
      "missing_required",
      "No models could be discovered from the custom provider. Check the base URL and credentials, or pass --custom-model-id explicitly.",
    );
  }
  return modelIds;
}

export function parseNonInteractiveCustomApiFlags(params: ParseNonInteractiveCustomApiFlagsParams) {
  const baseUrl = normalizeOptionalString(params.baseUrl) ?? "";
  const modelId = normalizeOptionalString(params.modelId) ?? "";
  const compatibility = parseCustomApiCompatibility(params.compatibility);
  if (!baseUrl || (compatibility === "anthropic" && !modelId)) {
    throw new CustomApiError(
      "missing_required",
      !baseUrl
        ? 'Auth choice "custom-api-key" requires --custom-base-url.'
        : "Anthropic-compatible custom providers require --custom-model-id.",
    );
  }

  const apiKey = normalizeOptionalString(params.apiKey);
  const providerId = normalizeOptionalString(params.providerId);
  assertValidCustomProviderId(providerId);
  if (params.noAuth && apiKey) {
    throw new CustomApiError(
      "no_auth_conflict",
      "Custom provider flags conflict: --custom-no-auth cannot be combined with --custom-api-key. Omit one.",
    );
  }
  return {
    baseUrl,
    modelId,
    compatibility,
    ...(apiKey ? { apiKey } : {}),
    ...(params.noAuth ? { noAuth: true } : {}),
    ...(providerId ? { providerId } : {}),
    ...(params.supportsImageInput === undefined
      ? {}
      : { supportsImageInput: params.supportsImageInput }),
  };
}

/** Applies custom provider config and optionally makes its model the primary model. */
export function applyCustomApiConfig(params: ApplyCustomApiConfigParams) {
  const baseUrl = normalizeOptionalString(params.baseUrl) ?? "";
  if (!isHttpUrl(baseUrl)) {
    throw new CustomApiError(
      "invalid_base_url",
      "Custom provider base URL must be a valid HTTP or HTTPS URL.",
    );
  }

  const modelId = normalizeOptionalString(params.modelId) ?? "";
  if (!modelId) {
    throw new CustomApiError("invalid_model_id", "Custom provider model ID is required.");
  }

  const isAzure = isAzureUrl(baseUrl);
  const api = resolveCustomProviderApi(params);
  const resolvedBaseUrl = isAzure ? transformAzureConfigUrl(baseUrl) : baseUrl;

  const providerIdResult = resolveCustomProviderId({
    config: params.config,
    baseUrl: resolvedBaseUrl,
    providerId: params.providerId,
  });
  const providerId = providerIdResult.providerId;
  const providers = params.config.models?.providers ?? {};
  const modelRef = modelKey(providerId, modelId);

  const alias = normalizeOptionalString(params.alias) ?? "";
  const aliasError = resolveCustomModelAliasError({
    raw: alias,
    cfg: params.config,
    modelRef: { provider: providerId, model: modelId },
    manifestPlugins: params.manifestPlugins ?? [],
    agentId: params.target?.agentId,
  });
  if (aliasError) {
    throw new CustomApiError("invalid_alias", aliasError);
  }

  const existingProvider = providers[providerId];
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const modelIds = params.modelIds ?? [modelId];
  const modelPositions = new Map(existingModels.map((model, index) => [model.id, index]));
  const mergedModels = [...existingModels];
  const reasoningModels = new Set<string>();
  const importedApis = new Set<ModelApi>();
  const explicitInput =
    params.supportsImageInput === undefined
      ? undefined
      : customModelInputs(params.supportsImageInput);
  // Keep the established reverse append order while merging the catalog once.
  for (const id of modelIds.toReversed()) {
    const position = modelPositions.get(id);
    const existingModel = position === undefined ? undefined : mergedModels[position];
    importedApis.add(existingModel?.api ?? api);
    const isReasoning = isAzure && /\b(o[134]|gpt-([5-9]|\d{2,}))\b/i.test(id);
    if (isReasoning) {
      reasoningModels.add(id);
    }
    const nextModel = {
      id,
      name: `${id} (Custom Provider)`,
      contextWindow: isAzure
        ? AZURE_DEFAULT_CONTEXT_WINDOW
        : CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW_TOKENS,
      maxTokens: isAzure ? AZURE_DEFAULT_MAX_TOKENS : DEFAULT_MAX_TOKENS,
      input:
        explicitInput ??
        customModelInputs(
          isAzure ? isReasoning : resolveCustomModelImageInputInference(id).supportsImageInput,
        ),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: isReasoning,
      ...(isAzure ? { compat: { supportsStore: false } } : {}),
    };
    if (existingModel && position !== undefined) {
      mergedModels[position] = {
        ...existingModel,
        ...(isAzure && !params.preserveExistingModelMetadata ? nextModel : {}),
        ...(explicitInput ? { input: explicitInput } : {}),
        name: existingModel.name ?? nextModel.name,
        cost: existingModel.cost ?? nextModel.cost,
        contextWindow: normalizeContextWindowForCustomModel(existingModel.contextWindow),
        maxTokens: existingModel.maxTokens ?? nextModel.maxTokens,
      };
    } else {
      modelPositions.set(id, mergedModels.length);
      mergedModels.push(nextModel);
    }
  }
  const {
    apiKey: existingApiKey,
    auth: existingAuth,
    ...existingProviderRest
  } = existingProvider ?? {};
  // An explicit key or no-auth choice on this call redeclares the provider's
  // auth mode; other authored values survive untouched.
  const redeclaresAuth = params.noAuth === true || params.apiKey !== undefined;
  const nextAuth = params.noAuth ? ("none" as const) : redeclaresAuth ? undefined : existingAuth;
  if (
    nextAuth === "none" &&
    [...importedApis].some((modelApi) => modelApi !== "openai-completions")
  ) {
    throw new CustomApiError(
      "no_auth_unsupported",
      'auth: "none" requires the openai-completions adapter. Select that adapter or configure an API key.',
    );
  }
  const normalizedApiKey = params.noAuth
    ? undefined
    : (normalizeOptionalProviderApiKey(params.apiKey) ??
      normalizeOptionalProviderApiKey(existingApiKey));

  // Azure clients use api-key headers and no bearer Authorization header.
  const azureHeaders = isAzure && normalizedApiKey ? { "api-key": normalizedApiKey } : undefined;

  const config: OpenClawConfig = {
    ...params.config,
    models: {
      ...params.config.models,
      mode: params.config.models?.mode ?? "merge",
      providers: {
        ...providers,
        [providerId]: {
          ...existingProviderRest,
          baseUrl: resolvedBaseUrl,
          api,
          ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
          ...(nextAuth ? { auth: nextAuth } : {}),
          ...(isAzure ? { authHeader: false } : {}),
          ...(azureHeaders ? { headers: azureHeaders } : {}),
          models: mergedModels,
        },
      },
    },
  };

  const applyModelDefaults = (modelConfig: OpenClawConfig): OpenClawConfig => {
    const updated =
      params.setAsPrimary === false ? modelConfig : applyPrimaryModel(modelConfig, modelRef);
    if (!params.modelIds && !reasoningModels.has(modelId) && !alias) {
      return updated;
    }
    const models = { ...updated.agents?.defaults?.models };
    for (const id of modelIds) {
      const ref = normalizeAgentModelRefForConfig(modelKey(providerId, id));
      const existing = models[ref];
      const seedThinking = reasoningModels.has(id) && !existing?.params?.thinking;
      models[ref] = {
        ...existing,
        ...(seedThinking ? { params: { ...existing?.params, thinking: "medium" } } : {}),
        ...(alias && id === modelId ? { alias } : {}),
      };
    }
    return {
      ...updated,
      agents: {
        ...updated.agents,
        defaults: {
          ...updated.agents?.defaults,
          models,
        },
      },
    };
  };

  return {
    config:
      params.target && params.config.agents?.ownership === "explicit"
        ? applyAgentModelDefaults(config, params.target, applyModelDefaults)
        : applyModelDefaults(config),
    providerId,
    modelId,
    ...(providerIdResult.providerIdRenamedFrom
      ? { providerIdRenamedFrom: providerIdResult.providerIdRenamedFrom }
      : {}),
  };
}
