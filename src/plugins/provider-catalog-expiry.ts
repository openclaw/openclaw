import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelServingContextLimit } from "../agents/model-serving-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type CatalogExpiryCapture = {
  providers: Map<string, number>;
  servingLimits: Map<string, ModelServingContextLimit[]>;
  observedServingLimits?: ModelServingContextLimit[];
  refreshKeys?: Set<string>;
  expiresAt?: number;
  discoveryBudget?: {
    timeoutMs: number | null;
    deadlineMs: number;
    providerTimeouts?: Readonly<Record<string, number>>;
  };
};

const capture = resolveGlobalSingleton(
  Symbol.for("openclaw.providerCatalogExpiryCapture"),
  () => new AsyncLocalStorage<CatalogExpiryCapture>(),
);

/** Carry the existing acquisition budget without adding provider configuration. */
export async function withProviderCatalogDiscoveryBudget<T>(
  timeoutMs: number | null,
  load: () => Promise<T>,
  providerTimeouts?: Readonly<Record<string, number>>,
): Promise<T> {
  const parent = capture.getStore();
  const current: CatalogExpiryCapture = {
    ...(parent ?? {
      providers: new Map(),
      servingLimits: new Map(),
    }),
    discoveryBudget: {
      providerTimeouts: providerTimeouts ?? parent?.discoveryBudget?.providerTimeouts,
      timeoutMs:
        timeoutMs === null
          ? (parent?.discoveryBudget?.timeoutMs ?? null)
          : Math.min(timeoutMs, parent?.discoveryBudget?.timeoutMs ?? Infinity),
      deadlineMs: Math.min(
        timeoutMs === null ? Infinity : performance.now() + timeoutMs,
        parent?.discoveryBudget?.deadlineMs ?? Infinity,
      ),
    },
  };
  const value = await capture.run(current, load);
  if (parent && current.expiresAt !== undefined) {
    parent.expiresAt = Math.min(parent.expiresAt ?? Infinity, current.expiresAt);
  }
  return value;
}

/** Stable budget identity is separate from the time remaining on this acquisition. */
export function getProviderCatalogDiscoveryBudget() {
  return capture.getStore()?.discoveryBudget;
}

/** Operator settings replace transport defaults; the admitted deadline still bounds acquisition. */
export function resolveProviderCatalogDiscoveryTimeoutMs(providerId: string, timeoutMs?: number) {
  if (timeoutMs === 0) {
    return 0;
  }
  const budget = getProviderCatalogDiscoveryBudget();
  return (
    budget?.providerTimeouts?.[normalizeProviderId(providerId)] ??
    timeoutMs ??
    budget?.timeoutMs ??
    5_000
  );
}

export async function captureProviderCatalogExpiries<T>(
  load: () => Promise<T>,
  options: { refresh?: boolean } = {},
) {
  const providers = new Map<string, number>();
  const refreshKeys = options.refresh ? new Set<string>() : undefined;
  const servingLimits = new Map<string, ModelServingContextLimit[]>();
  const value = await capture.run(
    {
      providers,
      refreshKeys,
      servingLimits,
      discoveryBudget: capture.getStore()?.discoveryBudget,
    },
    load,
  );
  return { value, providerExpiries: providers, servingLimits };
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
    servingLimits: parent.servingLimits,
    observedServingLimits: [],
    refreshKeys: parent.refreshKeys,
    discoveryBudget: parent.discoveryBudget,
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
