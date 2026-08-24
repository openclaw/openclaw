// Shared models.dev + gateway hybrid catalog: sticky metadata, short-lived gateway IDs.
import {
  getCachedLiveProviderModelRows,
  type LiveModelCatalogFetchGuard,
} from "./provider-catalog-live-runtime.js";
import { getCachedLiveCatalogValue } from "./provider-catalog-shared.js";
import { normalizeModelCompat } from "./provider-model-shared.js";
import type {
  ModelApi,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "./provider-model-shared.js";

export const MODELS_DEV_API_URL = "https://models.dev/api.json";
export const MODELS_DEV_TIMEOUT_MS = 15_000;
// The full models.dev document measured ~4.3MB in Aug 2026 and grows with new
// providers; it overflows the default live-catalog ceiling, so this endpoint
// carries its own bounded read (still capped, just with headroom).
export const MODELS_DEV_BODY_MAX_BYTES = 16 * 1024 * 1024;
// Metadata changes slowly and the document is large, so a successful fetch is
// process-sticky: fresh catalogs keep working without repeated third-party
// egress. Best-effort only — the shared bounded live-catalog cache may evict
// the entry under heavy key churn, degrading to refetch-on-next-use.
export const MODELS_DEV_PROCESS_STICKY_TTL_MS = 365 * 24 * 60 * 60 * 1000;
/** Short TTL for gateway model-id lists so availability can refresh. */
export const GATEWAY_MODEL_IDS_TTL_MS = 60_000;

export type ModelsDevModelRow = {
  id?: unknown;
  name?: unknown;
  reasoning?: unknown;
  status?: unknown;
  modalities?: { input?: unknown };
  limit?: { context?: unknown; output?: unknown };
  cost?: {
    input?: unknown;
    output?: unknown;
    cache_read?: unknown;
    cache_write?: unknown;
    tiers?: unknown;
    context_over_200k?: {
      input?: unknown;
      output?: unknown;
      cache_read?: unknown;
      cache_write?: unknown;
    };
  };
  provider?: { npm?: unknown };
};

export type ModelsDevProviderSlice = ReadonlyMap<string, ModelsDevModelRow>;

export type HybridModelDefinition = ModelDefinitionConfig & {
  provider: string;
  api: NonNullable<ModelDefinitionConfig["api"]>;
  baseUrl: string;
  input: Array<"text" | "image">;
};

export type HybridTransport = {
  api: ModelApi;
  baseUrl: string;
};

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatModelName(modelId: string): string {
  return modelId
    .split("-")
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export function mapModelsDevCost(
  cost: ModelsDevModelRow["cost"],
): ModelDefinitionConfig["cost"] | undefined {
  if (!cost || typeof cost !== "object") {
    return undefined;
  }
  const input = readNonNegativeNumber(cost.input);
  const output = readNonNegativeNumber(cost.output);
  if (input === undefined || output === undefined) {
    return undefined;
  }
  const cacheRead = readNonNegativeNumber(cost.cache_read) ?? 0;
  const cacheWrite = readNonNegativeNumber(cost.cache_write) ?? 0;
  const base = { input, output, cacheRead, cacheWrite };
  const tiers = Array.isArray(cost.tiers) ? cost.tiers : [];
  const mappedTiers: NonNullable<ModelDefinitionConfig["cost"]["tieredPricing"]> = [];
  for (const tier of tiers) {
    if (!tier || typeof tier !== "object" || Array.isArray(tier)) {
      continue;
    }
    const tierRecord = tier as {
      input?: unknown;
      output?: unknown;
      cache_read?: unknown;
      cache_write?: unknown;
      tier?: { type?: unknown; size?: unknown };
    };
    const tierInput = readNonNegativeNumber(tierRecord.input);
    const tierOutput = readNonNegativeNumber(tierRecord.output);
    const size = readPositiveNumber(tierRecord.tier?.size);
    if (tierInput === undefined || tierOutput === undefined || size === undefined) {
      continue;
    }
    if (mappedTiers.length === 0) {
      mappedTiers.push({ ...base, range: [0, size] });
    }
    mappedTiers.push({
      input: tierInput,
      output: tierOutput,
      cacheRead: readNonNegativeNumber(tierRecord.cache_read) ?? 0,
      cacheWrite: readNonNegativeNumber(tierRecord.cache_write) ?? 0,
      range: [size],
    });
  }
  if (mappedTiers.length > 0) {
    return { ...base, tieredPricing: mappedTiers };
  }
  const over = cost.context_over_200k;
  if (over && typeof over === "object") {
    const overInput = readNonNegativeNumber(over.input);
    const overOutput = readNonNegativeNumber(over.output);
    if (overInput !== undefined && overOutput !== undefined) {
      return {
        ...base,
        tieredPricing: [
          { ...base, range: [0, 200_000] },
          {
            input: overInput,
            output: overOutput,
            cacheRead: readNonNegativeNumber(over.cache_read) ?? 0,
            cacheWrite: readNonNegativeNumber(over.cache_write) ?? 0,
            range: [200_000],
          },
        ],
      };
    }
  }
  return base;
}

function mapModelsDevInput(modalities: ModelsDevModelRow["modalities"]): Array<"text" | "image"> {
  const raw = modalities?.input;
  if (!Array.isArray(raw)) {
    return ["text"];
  }
  return raw.includes("image") ? ["text", "image"] : ["text"];
}

export function parseModelsDevProviderSlice(
  document: unknown,
  providerKey: string,
): ModelsDevProviderSlice {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return new Map();
  }
  const provider = (document as Record<string, unknown>)[providerKey];
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    return new Map();
  }
  const models = (provider as { models?: unknown }).models;
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    return new Map();
  }
  const slice = new Map<string, ModelsDevModelRow>();
  for (const [rawId, row] of Object.entries(models as Record<string, unknown>)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const id = readString((row as ModelsDevModelRow).id) ?? rawId;
    const normalizedId = id.trim().toLowerCase();
    if (!normalizedId) {
      continue;
    }
    slice.set(normalizedId, row as ModelsDevModelRow);
  }
  return slice;
}

export async function fetchModelsDevProviderSlice(params: {
  providerKey: string;
  /** Auth context of the owning catalog; presence gates the third-party fetch. */
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
  fetchModelsDev?: () => Promise<unknown>;
  /** Optional suffix so injected fixtures do not collide across plugins. */
  injectedCacheKeySuffix?: string;
  now?: () => number;
}): Promise<ModelsDevProviderSlice> {
  try {
    // Test-injection seam: deliberately runs before the credential gate so
    // fixture-driven tests can exercise parsing offline. Production callers
    // never supply this loader; the network branch below stays gated.
    if (params.fetchModelsDev) {
      const document = await getCachedLiveCatalogValue({
        keyParts: [
          "models.dev",
          "api.json",
          "injected",
          ...(params.injectedCacheKeySuffix ? [params.injectedCacheKeySuffix] : []),
        ],
        ttlMs: MODELS_DEV_PROCESS_STICKY_TTL_MS,
        shouldCache: (value) => value !== null && typeof value === "object",
        load: params.fetchModelsDev,
        now: params.now,
      });
      return parseModelsDevProviderSlice(document, params.providerKey);
    }
    if (!params.apiKey && !params.discoveryApiKey) {
      // Privacy boundary: third-party metadata is fetched only for authenticated
      // provider catalogs; never as unsolicited process-wide egress.
      return new Map();
    }
    const rows = await getCachedLiveProviderModelRows({
      providerId: "models-dev",
      endpoint: MODELS_DEV_API_URL,
      fetchGuard: params.fetchGuard,
      signal: params.signal,
      timeoutMs: MODELS_DEV_TIMEOUT_MS,
      bodyMaxBytes: MODELS_DEV_BODY_MAX_BYTES,
      ttlMs: MODELS_DEV_PROCESS_STICKY_TTL_MS,
      auditContext: "models-dev-catalog",
      cacheKeyParts: ["models.dev", "api.json"],
      readRows: (body) => [body],
      // The whole document is one "row", so row-count is vacuous. Admit only
      // documents that look like a models.dev catalog — at least one top-level
      // provider slice carrying a models record — so a garbage 200 (CDN error
      // envelope, captive portal) cannot poison the year-sticky cache with
      // silent static degradation.
      shouldCacheRows: (modelRows) => {
        const doc = modelRows[0];
        if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
          return false;
        }
        return Object.values(doc as Record<string, unknown>).some((slice) => {
          if (!slice || typeof slice !== "object" || Array.isArray(slice)) {
            return false;
          }
          const models = (slice as { models?: unknown }).models;
          return Boolean(models) && typeof models === "object";
        });
      },
      now: params.now,
    });
    return parseModelsDevProviderSlice(rows[0], params.providerKey);
  } catch {
    return new Map();
  }
}

function readLiveModelId(row: unknown): string | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  const candidate = row as { id?: unknown; object?: unknown };
  if (candidate.object !== undefined && candidate.object !== "model") {
    return undefined;
  }
  if (typeof candidate.id !== "string") {
    return undefined;
  }
  const modelId = candidate.id.trim().toLowerCase();
  return modelId || undefined;
}

export function mapModelsDevRowToModel(params: {
  modelId: string;
  row: ModelsDevModelRow;
  providerId: string;
  resolveTransport: (modelId: string) => HybridTransport;
  staticBase?: HybridModelDefinition;
  applyPolicyOverlay: (
    model: HybridModelDefinition,
    staticBase: HybridModelDefinition | undefined,
  ) => HybridModelDefinition;
}): HybridModelDefinition {
  const transport = params.resolveTransport(params.modelId);
  const api = transport.api;
  const cost = mapModelsDevCost(params.row.cost) ??
    params.staticBase?.cost ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
  const contextWindow =
    readPositiveNumber(params.row.limit?.context) ?? params.staticBase?.contextWindow ?? 128_000;
  const maxTokens =
    readPositiveNumber(params.row.limit?.output) ?? params.staticBase?.maxTokens ?? 8_192;
  const name =
    readString(params.row.name) ?? params.staticBase?.name ?? formatModelName(params.modelId);
  const reasoning =
    typeof params.row.reasoning === "boolean"
      ? params.row.reasoning
      : (params.staticBase?.reasoning ?? true);
  const input =
    params.row.modalities?.input !== undefined
      ? mapModelsDevInput(params.row.modalities)
      : (params.staticBase?.input ?? ["text"]);
  const mapped = normalizeModelCompat({
    id: params.modelId,
    name,
    api,
    provider: params.providerId,
    baseUrl: transport.baseUrl,
    reasoning,
    input,
    cost,
    contextWindow,
    maxTokens,
    compat: {
      supportsUsageInStreaming: true,
      supportsReasoningEffort: reasoning,
      maxTokensField: "max_tokens",
      ...params.staticBase?.compat,
    },
    ...(params.staticBase?.thinkingLevelMap
      ? { thinkingLevelMap: params.staticBase.thinkingLevelMap }
      : {}),
  }) as HybridModelDefinition;
  return params.applyPolicyOverlay(mapped, params.staticBase);
}

export function buildHybridModelDefinitions(params: {
  gatewayIds: readonly string[];
  modelsDev: ModelsDevProviderSlice;
  staticModels: readonly HybridModelDefinition[];
  providerId: string;
  resolveTransport: (modelId: string) => HybridTransport;
  applyPolicyOverlay: (
    model: HybridModelDefinition,
    staticBase: HybridModelDefinition | undefined,
  ) => HybridModelDefinition;
  /** Gateway IDs that must never appear in hybrid catalogs. */
  skipGatewayIds?: ReadonlySet<string>;
}): HybridModelDefinition[] {
  const staticById = new Map(params.staticModels.map((model) => [model.id, model]));
  const skip = params.skipGatewayIds;
  const models: HybridModelDefinition[] = [];
  for (const rawId of params.gatewayIds) {
    const modelId = rawId.trim().toLowerCase();
    if (!modelId || skip?.has(modelId)) {
      continue;
    }
    const md = params.modelsDev.get(modelId);
    const base = staticById.get(modelId);
    // Metadata-only lifecycle signal: a models.dev-deprecated id with no static
    // base must not enter live catalogs; static seeds own their own rows.
    if (!base && readString(md?.status) === "deprecated") {
      continue;
    }
    if (md) {
      models.push(
        mapModelsDevRowToModel({
          modelId,
          row: md,
          providerId: params.providerId,
          resolveTransport: params.resolveTransport,
          staticBase: base,
          applyPolicyOverlay: params.applyPolicyOverlay,
        }),
      );
      continue;
    }
    if (base) {
      models.push(base);
    }
  }
  return models;
}

export async function fetchGatewayModelIds(params: {
  providerId: string;
  gatewayEndpoint: string;
  gatewayTimeoutMs: number;
  auditContext: string;
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
  skipGatewayIds?: ReadonlySet<string>;
  gatewayIdsTtlMs?: number;
  now?: () => number;
}): Promise<string[]> {
  const rows = await getCachedLiveProviderModelRows({
    providerId: params.providerId,
    endpoint: params.gatewayEndpoint,
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    timeoutMs: params.gatewayTimeoutMs,
    ttlMs: params.gatewayIdsTtlMs ?? GATEWAY_MODEL_IDS_TTL_MS,
    auditContext: params.auditContext,
    cacheKeyParts: [
      params.providerId,
      "gateway-model-ids",
      params.gatewayEndpoint,
      params.discoveryApiKey ?? params.apiKey,
    ],
    // Empty gateway lists are transient failures or offline; do not sticky-cache them.
    shouldCacheRows: (modelRows) => modelRows.length > 0,
    now: params.now,
  });
  const seen = new Set<string>();
  const modelIds: string[] = [];
  const skip = params.skipGatewayIds;
  for (const row of rows) {
    const modelId = readLiveModelId(row);
    if (!modelId || seen.has(modelId) || skip?.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    modelIds.push(modelId);
  }
  return modelIds;
}

/**
 * Loads hybrid models for one provider. Static fallback is never sticky-cached as a
 * successful hybrid so empty/transient gateway responses retry on the next need.
 *
 * Hybrid success is sticky only for the short gateway TTL window so availability
 * refreshes; models.dev metadata stays process-sticky separately.
 */
export async function buildHybridProviderConfig(params: {
  providerId: string;
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
  fetchModelsDev?: () => Promise<unknown>;
  modelsDevProviderKey: string;
  modelsDevInjectedCacheKeySuffix?: string;
  staticModels: readonly HybridModelDefinition[];
  gatewayEndpoint: string;
  gatewayTimeoutMs: number;
  gatewayAuditContext: string;
  openaiBaseUrl: string;
  resolveTransport: (modelId: string) => HybridTransport;
  applyPolicyOverlay: (
    model: HybridModelDefinition,
    staticBase: HybridModelDefinition | undefined,
  ) => HybridModelDefinition;
  skipGatewayIds?: ReadonlySet<string>;
  gatewayIdsTtlMs?: number;
  hybridSuccessTtlMs?: number;
  now?: () => number;
}): Promise<ModelProviderConfig> {
  const fallbackModels = params.staticModels;
  const buildProvider = (models: readonly HybridModelDefinition[]): ModelProviderConfig => ({
    api: "openai-completions",
    baseUrl: params.openaiBaseUrl,
    ...(params.apiKey ? { apiKey: params.apiKey } : {}),
    models: [...models],
  });

  try {
    // Gateway IDs refresh on a short TTL. Hybrid merge is re-run when that list
    // changes; we cache hybrid only when built from non-empty gateway IDs, using
    // the same short TTL so sticky success does not freeze availability for a year.
    const hybridModels = await getCachedLiveCatalogValue({
      keyParts: [
        params.providerId,
        "hybrid-catalog",
        params.discoveryApiKey ?? params.apiKey,
        params.gatewayEndpoint,
      ],
      ttlMs: params.hybridSuccessTtlMs ?? GATEWAY_MODEL_IDS_TTL_MS,
      // Only cache real hybrid builds. Static seed fallback must not become sticky success.
      shouldCache: (result) => result.kind === "hybrid" && result.models.length > 0,
      now: params.now,
      load: async () => {
        const [gatewayIds, modelsDev] = await Promise.all([
          fetchGatewayModelIds({
            providerId: params.providerId,
            gatewayEndpoint: params.gatewayEndpoint,
            gatewayTimeoutMs: params.gatewayTimeoutMs,
            auditContext: params.gatewayAuditContext,
            apiKey: params.apiKey,
            discoveryApiKey: params.discoveryApiKey,
            fetchGuard: params.fetchGuard,
            signal: params.signal,
            skipGatewayIds: params.skipGatewayIds,
            gatewayIdsTtlMs: params.gatewayIdsTtlMs,
            now: params.now,
          }),
          fetchModelsDevProviderSlice({
            providerKey: params.modelsDevProviderKey,
            apiKey: params.apiKey,
            discoveryApiKey: params.discoveryApiKey,
            fetchGuard: params.fetchGuard,
            signal: params.signal,
            fetchModelsDev: params.fetchModelsDev,
            injectedCacheKeySuffix: params.modelsDevInjectedCacheKeySuffix,
            now: params.now,
          }),
        ]);
        if (gatewayIds.length === 0) {
          return { kind: "static" as const, models: [...fallbackModels] };
        }
        const built = buildHybridModelDefinitions({
          gatewayIds,
          modelsDev,
          staticModels: fallbackModels,
          providerId: params.providerId,
          resolveTransport: params.resolveTransport,
          applyPolicyOverlay: params.applyPolicyOverlay,
          skipGatewayIds: params.skipGatewayIds,
        });
        if (built.length === 0) {
          return { kind: "static" as const, models: [...fallbackModels] };
        }
        return { kind: "hybrid" as const, models: built };
      },
    });
    if (hybridModels.models.length > 0) {
      return buildProvider(hybridModels.models);
    }
  } catch {
    // Hybrid discovery is advisory; keep the provider-owned static seed visible.
  }
  return buildProvider(fallbackModels);
}

/** Minimal structural slice of the plugin dynamic-model context this cache needs. */
export type HybridScopedModelContext = {
  modelRegistry: object;
  modelId: string;
  authProfileId?: string;
  authProfileMode?: string;
};

/**
 * Profile-scoped hybrid models for dynamic resolution. Keyed by the resolving
 * registry plus `profile:<id>` / `direct:<mode>` / `unscoped` so one credential's
 * catalog can never satisfy another profile's lookup; entries die with their
 * registry instead of leaking into a process-global last-loaded pointer.
 */
export class ScopedHybridModelCache {
  private readonly byRegistry = new WeakMap<
    object,
    Map<string, Map<string, HybridModelDefinition>>
  >();

  scopeKey(ctx: Pick<HybridScopedModelContext, "authProfileId" | "authProfileMode">): string {
    const normalizedProfileId = ctx.authProfileId?.trim();
    return normalizedProfileId
      ? `profile:${normalizedProfileId}`
      : ctx.authProfileMode
        ? `direct:${ctx.authProfileMode}`
        : "unscoped";
  }

  put(
    ctx: Pick<HybridScopedModelContext, "modelRegistry" | "authProfileId" | "authProfileMode">,
    models: readonly HybridModelDefinition[],
  ): void {
    let byScope = this.byRegistry.get(ctx.modelRegistry);
    if (!byScope) {
      byScope = new Map();
      this.byRegistry.set(ctx.modelRegistry, byScope);
    }
    byScope.set(
      this.scopeKey(ctx),
      new Map(models.map((model) => [model.id.trim().toLowerCase(), model])),
    );
  }

  get(ctx: HybridScopedModelContext): HybridModelDefinition | undefined {
    return this.byRegistry
      .get(ctx.modelRegistry)
      ?.get(this.scopeKey(ctx))
      ?.get(ctx.modelId.trim().toLowerCase());
  }
}

/**
 * Shared prepare/resolve hooks for provider plugins whose live hybrid catalogs
 * are credential-specific. `prepareDynamicModel` resolves the requesting
 * profile's own (then sibling) OpenCode-style shared key, warms that profile's
 * scoped map, and returns the model; `resolveDynamicModel` is the sync
 * profile-scoped lookup with no cross-profile fallback. Any failure degrades to
 * `undefined` so the plugin's static seed stays visible.
 */
export function createScopedHybridDynamicModelHooks(params: {
  /** Credential lookup order: the plugin's own provider id first, then sibling. */
  providerIds: readonly string[];
  buildLiveProviderConfig(apiKey: string): Promise<ModelProviderConfig>;
}): {
  prepareDynamicModel(
    ctx: HybridScopedModelContext & {
      config?: import("../config/types.openclaw.js").OpenClawConfig;
      agentDir?: string;
    },
  ): Promise<HybridModelDefinition | undefined>;
  resolveDynamicModel(ctx: HybridScopedModelContext): HybridModelDefinition | undefined;
} {
  const scopedModels = new ScopedHybridModelCache();

  async function resolveCredential(ctx: {
    config?: import("../config/types.openclaw.js").OpenClawConfig;
    agentDir?: string;
    authProfileId?: string;
  }): Promise<string | undefined> {
    const { resolveApiKeyForProvider } = await import("openclaw/plugin-sdk/provider-auth-runtime");
    for (const providerId of params.providerIds) {
      try {
        const auth = await resolveApiKeyForProvider({
          provider: providerId,
          ...(ctx.config ? { cfg: ctx.config } : {}),
          ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
          ...(ctx.authProfileId ? { profileId: ctx.authProfileId, lockedProfile: true } : {}),
        });
        if (auth?.apiKey) {
          return auth.apiKey;
        }
      } catch {
        // Try the next provider in the shared-key order; unauthenticated stays static.
      }
    }
    return undefined;
  }

  return {
    async prepareDynamicModel(ctx) {
      try {
        const apiKey = await resolveCredential(ctx);
        if (!apiKey) {
          return undefined;
        }
        const providerConfig = await params.buildLiveProviderConfig(apiKey);
        // Live builder rows and its static fallback both carry full runtime fields.
        scopedModels.put(ctx, providerConfig.models as HybridModelDefinition[]);
        return scopedModels.get(ctx);
      } catch {
        // Advisory discovery only: never fail resolution, let static serve.
        return undefined;
      }
    },
    resolveDynamicModel(ctx) {
      return scopedModels.get(ctx);
    },
  };
}
