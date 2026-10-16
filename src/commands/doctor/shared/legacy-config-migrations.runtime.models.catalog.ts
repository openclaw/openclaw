import { isDeepStrictEqual } from "node:util";
import type {
  ModelCatalog,
  NormalizedModelCatalogRow,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  modelTransportRoutesMatch,
  resolveUniqueCatalogModelRoute,
} from "../../../agents/model-compat-catalog.js";
import { getRecord, type LegacyConfigRule } from "../../../config/legacy.shared.js";
import { isModelThinkingFormat } from "../../../config/types.models.js";
// Doctor intentionally reads shipped catalogs only; remote rows must not influence migrations.
import { planManifestModelCatalogRows } from "../../../model-catalog/manifest-planner.js";
import { listOpenClawPluginManifestMetadata } from "../../../plugins/manifest-metadata-scan.js";
import { resolveProviderModelRoutes } from "../../../plugins/provider-model-routes.js";

const STALE_CONTEXT_WINDOW_FIXES: Record<string, { stale: number; correct: number }> = {
  "deepseek/deepseek-v4-flash": { stale: 200_000, correct: 1_000_000 },
  "xai/grok-4.20-0309-reasoning": { stale: 2_000_000, correct: 1_000_000 },
  "xai/grok-4.20-0309-non-reasoning": { stale: 2_000_000, correct: 1_000_000 },
  "xai/grok-4.20-beta-latest-reasoning": { stale: 2_000_000, correct: 1_000_000 },
  "xai/grok-4.20-beta-latest-non-reasoning": { stale: 2_000_000, correct: 1_000_000 },
  "xai/grok-4.20-experimental-beta-0304-reasoning": {
    stale: 2_000_000,
    correct: 1_000_000,
  },
  "xai/grok-4.20-experimental-beta-0304-non-reasoning": {
    stale: 2_000_000,
    correct: 1_000_000,
  },
  "xai/grok-4.20-reasoning": { stale: 2_000_000, correct: 1_000_000 },
  "xai/grok-4.20-non-reasoning": { stale: 2_000_000, correct: 1_000_000 },
} as const;
const DEAD_MODEL_COMPAT_KEYS = ["nativeWebSearchTool", "requiresMistralToolIds"] as const;

export function* providerModelEntries(providers: unknown) {
  for (const [providerId, value] of Object.entries(getRecord(providers) ?? {})) {
    const provider = getRecord(value);
    if (!provider || !Array.isArray(provider.models)) {
      continue;
    }
    for (const [modelIndex, modelValue] of provider.models.entries()) {
      const model = getRecord(modelValue);
      if (model) {
        yield { providerId, provider, modelIndex, model };
      }
    }
  }
}

function normalizedCatalogModelKey(provider: string, modelId: string): string {
  // Keep doctor identity aligned with runtime catalog lookup and merge keys,
  // which intentionally treat provider/model ids case-insensitively.
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedId = modelId.trim().toLowerCase();
  const providerPrefix = `${normalizedProvider}/`;
  return `${normalizedProvider}::${normalizedId.startsWith(providerPrefix) ? normalizedId.slice(providerPrefix.length) : normalizedId}`;
}

// Manifest metadata is process-stable; plugin installs/reloads restart the owning process.
const modelCompatCatalogRowsByProvider = new Map<string, readonly NormalizedModelCatalogRow[]>();
let modelCompatCatalogPlugins:
  | Array<{ id: string; modelCatalog: ModelCatalog; providers: string[] }>
  | undefined;

function getModelCompatCatalogPlugins() {
  modelCompatCatalogPlugins ??= listOpenClawPluginManifestMetadata().flatMap(({ manifest }) => {
    const id = typeof manifest.id === "string" ? manifest.id.trim() : "";
    const modelCatalog = getRecord(manifest.modelCatalog);
    if (!id || !modelCatalog) {
      return [];
    }
    return [
      {
        id,
        providers: Array.isArray(manifest.providers)
          ? manifest.providers.filter((value): value is string => typeof value === "string")
          : [],
        modelCatalog: modelCatalog as ModelCatalog,
      },
    ];
  });
  return modelCompatCatalogPlugins;
}

function buildConfiguredProviderCatalogRows(
  providers: Record<string, unknown>,
): Map<string, NormalizedModelCatalogRow[]> {
  const rows = new Map<string, NormalizedModelCatalogRow[]>();
  for (const providerId of Object.keys(providers)) {
    const normalizedProviderId = normalizeProviderId(providerId);
    let providerRows = modelCompatCatalogRowsByProvider.get(normalizedProviderId);
    if (!providerRows) {
      providerRows = planManifestModelCatalogRows({
        registry: { plugins: getModelCompatCatalogPlugins() },
        providerFilter: normalizedProviderId,
      }).rows;
      modelCompatCatalogRowsByProvider.set(normalizedProviderId, providerRows);
    }
    for (const row of providerRows) {
      const key = normalizedCatalogModelKey(row.provider, row.id);
      const variants = rows.get(key) ?? [];
      variants.push(row);
      rows.set(key, variants);
    }
  }
  return rows;
}

/** Resolves one catalog identity and whether its configured route remains provider-owned. */
export function resolveConfiguredModelCatalogOwnership(params: {
  providerId: string;
  provider: Record<string, unknown>;
  model: Record<string, unknown>;
}): { catalogRow: NormalizedModelCatalogRow; ownsRoute: boolean } | undefined {
  const modelId = typeof params.model.id === "string" ? params.model.id : "";
  if (!modelId) {
    return undefined;
  }
  const rows = buildConfiguredProviderCatalogRows({ [params.providerId]: params.provider }).get(
    normalizedCatalogModelKey(params.providerId, modelId),
  );
  const catalogRow = rows?.length === 1 ? rows[0] : undefined;
  if (!catalogRow) {
    return undefined;
  }
  const configuredRoute = {
    api: params.model.api ?? params.provider.api,
    baseUrl: params.model.baseUrl ?? params.provider.baseUrl,
  };
  const exactCatalogRoute = modelTransportRoutesMatch(catalogRow, configuredRoute);
  const providerRoutes = resolveProviderModelRoutes({
    provider: params.providerId,
    modelId,
    env: {},
  });
  const providerOwnedRoute =
    providerRoutes?.kind === "routes" &&
    providerRoutes.routes.some((route) => modelTransportRoutesMatch(route, configuredRoute));
  return { catalogRow, ownsRoute: exactCatalogRoute || providerOwnedRoute };
}

function* inspectModelCompatOverrides(providersValue: unknown) {
  const providers = getRecord(providersValue);
  if (!providers) {
    return;
  }
  const entries = [...providerModelEntries(providers)];
  if (!entries.some(({ model }) => getRecord(model.compat))) {
    return;
  }
  const catalogRows = buildConfiguredProviderCatalogRows(providers);
  for (const { providerId, provider, modelIndex, model } of entries) {
    const compat = getRecord(model.compat);
    const modelId = typeof model.id === "string" ? model.id : "";
    if (!compat || !modelId) {
      continue;
    }
    const catalogRow = resolveUniqueCatalogModelRoute(
      catalogRows.get(normalizedCatalogModelKey(providerId, modelId)),
      { api: model.api ?? provider.api, baseUrl: model.baseUrl ?? provider.baseUrl },
    );
    const dead = DEAD_MODEL_COMPAT_KEYS.filter((key) => Object.hasOwn(compat, key));
    const matching: string[] = [];
    const divergent: string[] = [];
    if (catalogRow) {
      const catalogCompat = catalogRow.compat ?? {};
      for (const [key, value] of Object.entries(compat)) {
        if ((DEAD_MODEL_COMPAT_KEYS as readonly string[]).includes(key)) {
          continue;
        }
        (isDeepStrictEqual(value, catalogCompat[key as keyof typeof catalogCompat])
          ? matching
          : divergent
        ).push(key);
      }
    }
    yield { compat, model, modelIndex, providerId, dead, matching, divergent };
  }
}

function hasModelCompatOverrides(providers: unknown, kind: "dead" | "matching" | "divergent") {
  for (const entry of inspectModelCompatOverrides(providers)) {
    if (entry[kind].length > 0) {
      return true;
    }
  }
  return false;
}

export const MODEL_COMPAT_CATALOG_RULES: LegacyConfigRule[] = [
  {
    path: ["models", "providers"],
    message:
      'nativeWebSearchTool and requiresMistralToolIds are unused and retired; run "openclaw doctor --fix" to remove them.',
    match: (value) => hasModelCompatOverrides(value, "dead"),
  },
  {
    path: ["models", "providers"],
    message:
      'Catalog-known model compat values are provider-owned; run "openclaw doctor --fix" to remove matching config overrides.',
    match: (value) => hasModelCompatOverrides(value, "matching"),
  },
  {
    path: ["models", "providers"],
    message:
      "Catalog-known model compat differs from the provider catalog and was preserved for review. Use a distinct custom route when the endpoint really has different capabilities.",
    match: (value) => hasModelCompatOverrides(value, "divergent"),
  },
];

export function migrateModelCompatCatalogOwnership(
  raw: Record<string, unknown>,
  changes: string[],
): void {
  const providers = getRecord(getRecord(raw.models)?.providers);
  for (const {
    compat,
    model,
    modelIndex,
    providerId,
    dead,
    matching,
  } of inspectModelCompatOverrides(providers)) {
    const removed = [...dead, ...matching];
    if (removed.length === 0) {
      continue;
    }
    for (const key of removed) {
      delete compat[key];
    }
    if (Object.keys(compat).length === 0) {
      delete model.compat;
    }
    changes.push(
      `Removed models.providers.${providerId}.models.${modelIndex}.compat catalog/dead overrides: ${removed.toSorted().join(", ")}.`,
    );
  }
}

function resolveStaleContextWindowFix(params: {
  providerId: string;
  modelId: string;
  contextWindow: number;
}): { stale: number; correct: number } | undefined {
  const providerId = params.providerId.trim().toLowerCase();
  const modelId = params.modelId.trim().toLowerCase();
  const providerPrefix = `${providerId}/`;
  const unprefixedModelId = modelId.startsWith(providerPrefix)
    ? modelId.slice(providerPrefix.length)
    : modelId;
  const scopedModelId = `${providerId}/${unprefixedModelId}`;
  const fix = STALE_CONTEXT_WINDOW_FIXES[scopedModelId];
  return fix && params.contextWindow === fix.stale ? fix : undefined;
}

export function* staleModelContextWindows(providers: unknown) {
  for (const entry of providerModelEntries(providers)) {
    const { providerId, model } = entry;
    const modelId = typeof model.id === "string" ? model.id : undefined;
    const contextWindow = model.contextWindow;
    if (!modelId || typeof contextWindow !== "number" || !Number.isFinite(contextWindow)) {
      continue;
    }
    const fix = resolveStaleContextWindowFix({ providerId, modelId, contextWindow });
    if (fix) {
      yield { ...entry, modelId, contextWindow, fix };
    }
  }
}

export function hasStaleContextWindowValue(providers: unknown): boolean {
  return !staleModelContextWindows(providers).next().done;
}

export function* invalidModelThinkingFormats(providers: unknown) {
  for (const entry of providerModelEntries(providers)) {
    const { model } = entry;
    const compat = getRecord(model.compat);
    const thinkingFormat = compat?.thinkingFormat;
    if (compat && typeof thinkingFormat === "string" && !isModelThinkingFormat(thinkingFormat)) {
      yield { ...entry, compat, thinkingFormat };
    }
  }
}

export function hasInvalidThinkingFormat(providers: unknown): boolean {
  return !invalidModelThinkingFormats(providers).next().done;
}
