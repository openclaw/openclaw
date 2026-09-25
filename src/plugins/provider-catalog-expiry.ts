import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type CatalogExpiryCapture = {
  providers: Map<string, number>;
  models: Map<string, Set<string>>;
  expiresAt?: number;
};

const capture = resolveGlobalSingleton(
  Symbol.for("openclaw.providerCatalogExpiryCapture"),
  () => new AsyncLocalStorage<CatalogExpiryCapture>(),
);

export async function captureProviderCatalogExpiries<T>(load: () => Promise<T>) {
  const providers = new Map<string, number>();
  const models = new Map<string, Set<string>>();
  const value = await capture.run({ providers, models }, load);
  return { value, providerExpiries: providers, providerModels: models };
}

export async function withProviderCatalogExpiry<T>(
  load: () => Promise<T>,
  providerIds: (value: T) => string[],
): Promise<T> {
  const parent = capture.getStore();
  if (!parent) {
    return load();
  }
  const current: CatalogExpiryCapture = { providers: parent.providers, models: parent.models };
  const value = await capture.run(current, load);
  if (current.expiresAt !== undefined) {
    for (const provider of providerIds(value)) {
      const previous = parent.providers.get(provider);
      parent.providers.set(provider, Math.min(previous ?? Infinity, current.expiresAt));
    }
  }
  return value;
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

/** Carry the cache's original deadline; a cache hit must not extend inventory freshness. */
export function recordLiveCatalogExpiry(expiresAt: number): void {
  const current = capture.getStore();
  if (current) {
    current.expiresAt = Math.min(current.expiresAt ?? Infinity, expiresAt);
  }
}
