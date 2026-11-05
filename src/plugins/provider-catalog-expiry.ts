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

type DiscoveryBudget = NonNullable<CatalogExpiryCapture["discoveryBudget"]>;
type BudgetClock = ReturnType<typeof sampleProviderCatalogBudgetClock>;
type BudgetOrigin = {
  parent: {
    present: boolean;
    timeoutMs?: number | null;
    deadlineMs?: number;
    originKnown: boolean;
  };
  requestedTimeout: number | null;
  clock: BudgetClock;
  authCacheKey?: { load: WeakRef<object>; before: BudgetClock; after: BudgetClock };
};
type LoadOrigin = {
  budget: DiscoveryBudget | undefined;
  owner: typeof capture;
  entry: BudgetClock;
  load: BudgetClock;
  ttlWallNow: number;
  disposition: "uncached" | "new-load";
};

// Weak, fixed-size records follow the actual objects across duplicated SDK modules.
// They retain no provider, credential, cache key, URL or parent-origin chain.
const budgetOrigins = resolveGlobalSingleton(
  Symbol.for("openclaw.catalogBudgetOrigins.v1"),
  () => ({
    budgets: new WeakMap<object, BudgetOrigin>(),
    loads: new WeakMap<object, LoadOrigin>(),
    requests: new WeakMap<object, { load: object; origin: LoadOrigin | undefined }>(),
  }),
);

export function sampleProviderCatalogBudgetClock() {
  const clock = performance;
  const nowFunction: typeof clock.now = Reflect.get(clock, "now");
  return {
    now: nowFunction.call(clock),
    wall: Date.now(),
    timeOrigin: clock.timeOrigin,
    clock,
    nowFunction,
  };
}

export function recordProviderCatalogAuthCacheKeyOrigin(
  load: object,
  before: BudgetClock,
  after: BudgetClock,
) {
  const budget = getProviderCatalogDiscoveryBudget();
  const origin = budget && budgetOrigins.budgets.get(budget);
  if (origin) {
    origin.authCacheKey = { load: new WeakRef(load), before, after };
  }
}

export function recordProviderCatalogLoadOrigin(
  load: object,
  entry: BudgetClock,
  ttlWallNow: number,
  disposition: LoadOrigin["disposition"],
) {
  budgetOrigins.loads.set(load, {
    budget: getProviderCatalogDiscoveryBudget(),
    owner: capture,
    entry,
    load: sampleProviderCatalogBudgetClock(),
    ttlWallNow,
    disposition,
  });
}

export function bindProviderCatalogInvocationOrigin(load: object, params: object) {
  budgetOrigins.requests.set(params, { load, origin: budgetOrigins.loads.get(load) });
}

function diagnosticNumber(value: number | null | undefined) {
  if (value === undefined) {
    return "unknown";
  }
  if (value === null) {
    return "unbounded";
  }
  if (Number.isFinite(value)) {
    return value;
  }
  return Number.isNaN(value) ? "nan" : value > 0 ? "positive_infinity" : "negative_infinity";
}

export function providerCatalogBudgetOriginCause(
  params: object,
  acquisition: BudgetClock,
  configuredLimit: number,
  derivedTimeoutMs: number,
  startedAt: number,
  guard: BudgetClock,
  remainingTimeoutMs: number,
  pageIndex: number,
) {
  const budget = getProviderCatalogDiscoveryBudget();
  const child = budget && budgetOrigins.budgets.get(budget);
  const invocation = budgetOrigins.requests.get(params);
  const load = invocation?.origin;
  const keyOrigin = child?.authCacheKey;
  const sameAuthCacheKeyLoad = keyOrigin
    ? invocation !== undefined && keyOrigin.load.deref() === invocation.load
    : "unknown";
  const key = sameAuthCacheKeyLoad === true ? keyOrigin : undefined;
  const clocks =
    child && load
      ? [
          child.clock,
          ...(key ? [key.before, key.after] : []),
          load.entry,
          load.load,
          acquisition,
          guard,
        ]
      : undefined;
  return {
    kind: "catalog_budget_origin_v1",
    parent: {
      present: child?.parent.present ?? "unknown",
      timeoutMs: diagnosticNumber(child?.parent.timeoutMs),
      deadlineMs: diagnosticNumber(child?.parent.deadlineMs),
      originKnown: child?.parent.originKnown ?? false,
    },
    child: {
      requestedTimeoutMs: diagnosticNumber(child?.requestedTimeout),
      effectiveTimeoutMs: diagnosticNumber(budget?.timeoutMs),
      constructionNow: diagnosticNumber(child?.clock.now),
      deadlineMs: diagnosticNumber(budget?.deadlineMs),
      timeOrigin: diagnosticNumber(child?.clock.timeOrigin),
      wallNow: diagnosticNumber(child?.clock.wall),
    },
    authCacheKey: {
      beforeNow: diagnosticNumber(key?.before.now),
      afterNow: diagnosticNumber(key?.after.now),
      beforeWallNow: diagnosticNumber(key?.before.wall),
      afterWallNow: diagnosticNumber(key?.after.wall),
    },
    cache: {
      entryNow: diagnosticNumber(load?.entry.now),
      loadNow: diagnosticNumber(load?.load.now),
      ttlWallNow: diagnosticNumber(load?.ttlWallNow),
      disposition: load?.disposition ?? "unknown",
    },
    acquisition: {
      now: diagnosticNumber(acquisition.now),
      configuredLimit: diagnosticNumber(configuredLimit),
      derivedTimeoutMs: diagnosticNumber(derivedTimeoutMs),
      startedAt: diagnosticNumber(startedAt),
      wallNow: diagnosticNumber(acquisition.wall),
    },
    guard: {
      now: diagnosticNumber(guard.now),
      remainingTimeoutMs: diagnosticNumber(remainingTimeoutMs),
      pageIndex,
    },
    binding: {
      sameLoad: invocation && load ? budgetOrigins.loads.get(invocation.load) === load : "unknown",
      sameBudget: load ? load.budget === budget : "unknown",
      sameOwner: load ? load.owner === capture : "unknown",
      sameAuthCacheKeyLoad,
      sameClockObject: clocks
        ? clocks.every((value) => value.clock === acquisition.clock)
        : "unknown",
      sameNowFunction: clocks
        ? clocks.every((value) => value.nowFunction === acquisition.nowFunction)
        : "unknown",
      timeOrigins: clocks?.map((value) => diagnosticNumber(value.timeOrigin)) ?? "unknown",
    },
  };
}

/** Carry the existing acquisition budget without adding provider configuration. */
export async function withProviderCatalogDiscoveryBudget<T>(
  timeoutMs: number | null,
  load: () => Promise<T>,
  providerTimeouts?: Readonly<Record<string, number>>,
): Promise<T> {
  const parent = capture.getStore();
  const clock = sampleProviderCatalogBudgetClock();
  const current: CatalogExpiryCapture & { discoveryBudget: DiscoveryBudget } = {
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
        timeoutMs === null ? Infinity : clock.now + timeoutMs,
        parent?.discoveryBudget?.deadlineMs ?? Infinity,
      ),
    },
  };
  budgetOrigins.budgets.set(current.discoveryBudget, {
    parent: {
      present: parent?.discoveryBudget !== undefined,
      timeoutMs: parent?.discoveryBudget?.timeoutMs,
      deadlineMs: parent?.discoveryBudget?.deadlineMs,
      originKnown: !parent?.discoveryBudget || budgetOrigins.budgets.has(parent.discoveryBudget),
    },
    requestedTimeout: timeoutMs,
    clock,
  });
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
