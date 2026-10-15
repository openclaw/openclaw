import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelServingContextLimit } from "../agents/model-serving-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type CatalogExpiryCapture = {
  providers: Map<string, number>;
  models: Map<string, Set<string>>;
  servingLimits: Map<string, ModelServingContextLimit[]>;
  observedServingLimits?: ModelServingContextLimit[];
  refreshKeys?: Set<string>;
  expiresAt?: number;
};

const capture = resolveGlobalSingleton(
  Symbol.for("openclaw.providerCatalogExpiryCapture"),
  () => new AsyncLocalStorage<CatalogExpiryCapture>(),
);

export async function captureProviderCatalogExpiries<T>(
  load: () => Promise<T>,
  options: { refresh?: boolean } = {},
) {
  const providers = new Map<string, number>();
  const models = new Map<string, Set<string>>();
  const refreshKeys = options.refresh ? new Set<string>() : undefined;
  const servingLimits = new Map<string, ModelServingContextLimit[]>();
  const value = await capture.run({ providers, models, refreshKeys, servingLimits }, load);
  return { value, providerExpiries: providers, providerModels: models, servingLimits };
}

export async function withProviderCatalogExpiry<T>(
  load: () => Promise<T>,
  providerIds: (value: T) => string[],
): Promise<T> {
  const parent = capture.getStore();
  if (!parent) {
    return load();
  }
  const current: CatalogExpiryCapture = {
    providers: parent.providers,
    models: parent.models,
    servingLimits: parent.servingLimits,
    observedServingLimits: [],
    refreshKeys: parent.refreshKeys,
  };
  const value = await capture.run(current, load);
  for (const provider of providerIds(value)) {
    if (current.expiresAt !== undefined) {
      const previous = parent.providers.get(provider);
      parent.providers.set(provider, Math.min(previous ?? Infinity, current.expiresAt));
    }
    if (current.observedServingLimits?.length) {
      parent.servingLimits.set(provider, current.observedServingLimits);
    }
  }
  return value;
}

/** Bypass each selected response once, even when sibling hooks share its cache key. */
export function consumeLiveCatalogRefresh(key: string): boolean {
  const keys = capture.getStore()?.refreshKeys;
  if (!keys || keys.has(key)) {
    return false;
  }
  // Joining a pending load also satisfies this acquisition's refresh intent.
  keys.add(key);
  return true;
}

/** Record accepted hook identities, never static fallback or merged configured rows. */
export function recordProviderCatalogModels(provider: string, modelIds: readonly string[]): void {
  const current = capture.getStore();
  if (!current) {
    return;
  }
  const models = current.models.get(provider) ?? new Set<string>();
  for (const id of modelIds) {
    if (id.trim()) {
      models.add(id.trim());
    }
  }
  current.models.set(provider, models);
}

/** Hook-local observations publish only when the catalog owner accepts the hook result. */
export function recordLiveServingContextLimit(limit: ModelServingContextLimit): void {
  capture.getStore()?.observedServingLimits?.push(limit);
}

/** Carry the cache's original deadline; a cache hit must not extend inventory freshness. */
export function recordLiveCatalogExpiry(expiresAt: number): void {
  const current = capture.getStore();
  if (current) {
    current.expiresAt = Math.min(current.expiresAt ?? Infinity, expiresAt);
  }
}
