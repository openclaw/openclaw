import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
  type AuthProfileStore,
} from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { UsageSummary } from "../../infra/provider-usage.types.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { GatewayClient } from "./types.js";

const mocks = vi.hoisted(() => ({
  ensureStore: vi.fn(),
  listDescriptors: vi.fn(),
  loadSummary: vi.fn(),
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles.js")>()),
  ensureAuthProfileStoreAsync: mocks.ensureStore,
  externalCliDiscoveryForConfigStatus: vi.fn(() => undefined),
}));
vi.mock("../../plugins/provider-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/provider-runtime.js")>()),
  listProviderUsagePluginDescriptors: mocks.listDescriptors,
}));
// mock-isolation: Control usage refresh completion without querying real provider accounts.
vi.mock("../../infra/provider-usage.load.js", () => ({
  loadProviderUsageSummary: mocks.loadSummary,
}));

import {
  clearModelAuthStatusUsageCache,
  observeProviderUsageMetrics,
  readProviderUsage,
} from "./models-auth-status-usage-cache.js";
import { getProviderUsageRuntimeSnapshot } from "./provider-usage-runtime.js";
import { invokeUsage, usageClient, usageReply } from "./usage.test-support.js";

const config: OpenClawConfig = { agents: { entries: { main: {} } } };
const statusClient = usageClient();
const refreshingCapableClient = {
  ...statusClient,
  connect: { ...statusClient.connect, caps: ["usage-refreshing"] },
};
const providerDescriptor = { provider: "openai", displayName: "OpenAI" };
const visibleProvider = { providers: [{ provider: "openai" }] };
const oauthProfile = {
  type: "oauth" as const,
  provider: "openai",
  refresh: "refresh-one",
  expires: 1_000_000,
};

function usageSummary(updatedAt: number, usedPercent: number): UsageSummary {
  return {
    updatedAt,
    providers: [{ ...providerDescriptor, windows: [{ label: "5h", usedPercent }], plan: "Plus" }],
  };
}

function createStore(
  profiles: Record<string, string> = { default: "access-one" },
): AuthProfileStore {
  return {
    version: 1,
    profiles: Object.fromEntries(
      Object.entries(profiles).map(([id, access]) => [`openai:${id}`, { ...oauthProfile, access }]),
    ),
  };
}

async function runUsageStatus(
  client: GatewayClient | null = null,
  runtimeConfig: OpenClawConfig = config,
) {
  const [ok, payload] = usageReply(
    await invokeUsage("usage.status", {}, runtimeConfig, {
      client,
      context: { getRuntimeConfig: () => runtimeConfig },
    }),
  );
  expect(ok).toBe(true);
  return expectDefined(payload, "usage.status result");
}

function runCapableUsageStatus(runtimeConfig = config) {
  return runUsageStatus(refreshingCapableClient, runtimeConfig);
}

async function settledStatus(client: GatewayClient | null = refreshingCapableClient) {
  const scope = new AsyncWorkScope();
  try {
    return await scope.track(() => runUsageStatus(client));
  } finally {
    await scope.drain();
  }
}

describe("usage.status provider usage cache", () => {
  let now = 1_000;
  let store = createStore();

  function publishStore(next: AuthProfileStore) {
    store = next;
    const agentDir = resolveAgentDir(config, resolveDefaultAgentId(config));
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store }]);
  }

  beforeEach(() => {
    now = 1_000;
    store = createStore();
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.clearAllMocks();
    clearModelAuthStatusUsageCache();
    mocks.ensureStore.mockImplementation(() => store);
    mocks.listDescriptors.mockReturnValue([providerDescriptor]);
    mocks.loadSummary.mockImplementation(async () =>
      usageSummary(now, mocks.loadSummary.mock.calls.length * 10),
    );
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns a cold marker only to capable clients and retains invalidated refresh work", async () => {
    const scope = new AsyncWorkScope();
    const heldRefresh = createDeferredCore<UsageSummary>();
    const original: UsageSummary = { updatedAt: now, providers: [] };
    let draining: Promise<void> | undefined;
    mocks.loadSummary.mockImplementationOnce(() => heldRefresh.promise);
    try {
      await expect(scope.track(runCapableUsageStatus)).resolves.toEqual({
        updatedAt: now,
        providers: [],
        refreshing: true,
      });
      clearModelAuthStatusUsageCache();
      const current = (await runUsageStatus()) as UsageSummary;
      expect(current.providers[0]?.windows[0]?.usedPercent).toBe(20);

      let drained = false;
      draining = scope.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      heldRefresh.resolve(original);
      await draining;
      expect(drained).toBe(true);
      await expect(runUsageStatus()).resolves.toEqual(current);
      expect(mocks.loadSummary).toHaveBeenCalledTimes(2);
    } finally {
      heldRefresh.resolve(original);
      await Promise.allSettled([mocks.loadSummary.mock.results[0]?.value]);
      await (draining ?? scope.drain());
    }
  });

  it.each([false, true])(
    "refreshes bookkeeping only when profile selection changes: %s",
    async (selectionChanges) => {
      publishStore({
        ...createStore({ first: "access-first", second: "access-second" }),
        usageStats: { "openai:first": { lastUsed: 100 }, "openai:second": { lastUsed: 200 } },
      });
      await expect(settledStatus()).resolves.toMatchObject({ refreshing: true });
      if (!selectionChanges) {
        await expect(runCapableUsageStatus()).resolves.toMatchObject(visibleProvider);
      }
      expect(mocks.loadSummary).toHaveBeenCalledTimes(1);
      publishStore({
        ...store,
        usageStats: {
          "openai:first": { lastUsed: selectionChanges ? 300 : 100 },
          "openai:second": { lastUsed: selectionChanges ? 200 : 300 },
        },
      });
      now += 1;
      if (selectionChanges) {
        await expect(settledStatus()).resolves.toMatchObject({ refreshing: true });
      }
      await expect(runCapableUsageStatus()).resolves.toMatchObject(visibleProvider);
      expect(mocks.loadSummary).toHaveBeenCalledTimes(selectionChanges ? 2 : 1);
    },
  );

  it("keeps a failed refresh incomplete for capable clients and recovers", async () => {
    mocks.loadSummary.mockRejectedValueOnce(new Error("provider stack down"));
    await expect(settledStatus()).resolves.toMatchObject({ refreshing: true });
    await expect(settledStatus()).resolves.toMatchObject({ refreshing: true });
    await expect(runCapableUsageStatus()).resolves.toMatchObject({
      providers: [expect.any(Object)],
    });
  });

  it.each([false, true])("serves stale usage while refreshing (timeout: %s)", async (timeout) => {
    const first = (await runUsageStatus()) as UsageSummary;
    now = 61_000;
    if (timeout) {
      mocks.loadSummary.mockResolvedValueOnce({
        updatedAt: now,
        providers: [{ ...providerDescriptor, windows: [], error: "Timeout" }],
      });
    }
    expect(JSON.stringify(await settledStatus(null))).toBe(JSON.stringify(first));
    now = 62_000;
    const retained = (await runUsageStatus()) as UsageSummary;
    expect(retained).toEqual(timeout ? first : usageSummary(61_000, 20));
    expect(mocks.loadSummary).toHaveBeenCalledTimes(2);
  });
  it("preserves auth quota across failures without hiding usage.status errors", async () => {
    await runUsageStatus();
    for (const error of ["HTTP 503", "Unauthorized"]) {
      now += 60_000;
      mocks.loadSummary.mockResolvedValue({
        updatedAt: now,
        providers: [{ ...providerDescriptor, windows: [], error }],
      });
      await settledStatus();
      await expect(runUsageStatus()).resolves.toMatchObject({
        providers: [{ ...providerDescriptor, windows: [], error }],
      });
      const authUsage = await readProviderUsage({
        ...(await getProviderUsageRuntimeSnapshot({ config })),
        providerIds: ["openai"],
        now,
      });
      expect(authUsage.usageByProvider.get("openai")?.windows).toEqual([
        { label: "5h", usedPercent: 10 },
      ]);
    }
  });

  it.each([undefined, 120_000, 0])(
    "paces post-run usage with cacheTtlMs=%s",
    async (cacheTtlMs) => {
      const snapshot = await getProviderUsageRuntimeSnapshot({
        config: { ...config, models: { usage: { cacheTtlMs } } },
      });
      const read = () => readProviderUsage({ ...snapshot, now, awaitRefresh: true });
      const ttl = cacheTtlMs ?? 60_000;
      expect((await read()).refreshAt).toBe(now + ttl);
      for (let run = 0; run < 10; run += 1) {
        await read();
      }
      expect(mocks.loadSummary).toHaveBeenCalledTimes(ttl === 0 ? 11 : 1);
      now += ttl;
      await read();
      expect(mocks.loadSummary).toHaveBeenCalledTimes(ttl === 0 ? 12 : 2);
    },
  );

  it("refreshes each provider set once per TTL when page reads interleave", async () => {
    // models.authStatus polls refreshable credentials only; usage.status polls every descriptor.
    mocks.listDescriptors.mockReturnValue([
      providerDescriptor,
      { provider: "anthropic", displayName: "Anthropic" },
    ]);
    const readAuthStatusUsage = async () =>
      readProviderUsage({
        ...(await getProviderUsageRuntimeSnapshot({ config })),
        providerIds: ["openai"],
        now,
      });
    for (let load = 0; load < 3; load += 1) {
      const scope = new AsyncWorkScope();
      await Promise.all([
        scope.track(readAuthStatusUsage),
        scope.track(() => runUsageStatus(refreshingCapableClient)),
      ]);
      await scope.drain();
      now += 1_000;
    }
    expect(mocks.loadSummary).toHaveBeenCalledTimes(2);
    expect((await readAuthStatusUsage()).usageByProvider.get("openai")).toBeDefined();
    await expect(runCapableUsageStatus()).resolves.toMatchObject(visibleProvider);
    expect(mocks.loadSummary).toHaveBeenCalledTimes(2);
  });

  it("observes sanitized cache-owned allowance metrics and retains them across timeouts", async () => {
    await runUsageStatus();
    now = 61_000;
    mocks.loadSummary.mockResolvedValueOnce({
      updatedAt: now,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [],
          accountEmail: "must-not-escape@example.com",
          error: "Timeout",
        },
      ],
    });

    const snapshots: Parameters<
      Parameters<typeof observeProviderUsageMetrics>[0]["listener"]
    >[0][] = [];
    const release = observeProviderUsageMetrics({
      getConfig: () => config,
      listener: (snapshot) => snapshots.push(snapshot),
      refreshIntervalMs: 3_600_000,
    });
    try {
      await vi.waitFor(() => {
        expect(snapshots.at(-1)?.providers).toEqual([
          {
            provider: "openai",
            windows: [{ window: "5h", usedRatio: 0.1 }],
            lastAttemptTimestampSeconds: 61,
            lastSuccessTimestampSeconds: 1,
            refreshSuccess: false,
            refreshOutcome: "timeout",
          },
        ]);
      });
      expect(JSON.stringify(snapshots)).not.toContain("must-not-escape@example.com");
      expect(mocks.loadSummary).toHaveBeenCalledTimes(2);
    } finally {
      release();
    }
  });

  it("preserves distinct bounded identities for colliding provider windows", async () => {
    mocks.loadSummary.mockResolvedValue({
      updatedAt: now,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [
            { label: "Tokens (6h)", usedPercent: 32, resetAt: 1_700_003_600_000 },
            { label: "Tokens (15m)", usedPercent: 8, resetAt: 1_700_000_900_000 },
            { label: "Tokens (Limit)", usedPercent: 10 },
            { label: "Tokens (Limit)", usedPercent: 20 },
            { label: "Extra usage", usedPercent: 30 },
            { label: "Team usage", usedPercent: 40 },
            { label: "unknown_2", usedPercent: 50 },
          ],
        },
      ],
    });
    const snapshots: Parameters<
      Parameters<typeof observeProviderUsageMetrics>[0]["listener"]
    >[0][] = [];
    const release = observeProviderUsageMetrics({
      getConfig: () => config,
      listener: (snapshot) => snapshots.push(snapshot),
      refreshIntervalMs: 3_600_000,
    });
    try {
      await vi.waitFor(() => {
        expect(snapshots.at(-1)?.providers[0]?.windows).toEqual([
          {
            window: "tokens_6h",
            usedRatio: 0.32,
            resetTimestampSeconds: 1_700_003_600,
          },
          {
            window: "tokens_15m",
            usedRatio: 0.08,
            resetTimestampSeconds: 1_700_000_900,
          },
          { window: "tokens_limit", usedRatio: 0.1 },
          { window: "tokens_limit_2", usedRatio: 0.2 },
          { window: "unknown", usedRatio: 0.3 },
          { window: "unknown_2", usedRatio: 0.4 },
          { window: "unknown_2_2", usedRatio: 0.5 },
        ]);
      });
    } finally {
      release();
    }
  });

  it("classifies a refresh exception as a failed provider observation", async () => {
    mocks.loadSummary.mockRejectedValueOnce(new Error("401 Unauthorized"));
    const snapshots: Parameters<
      Parameters<typeof observeProviderUsageMetrics>[0]["listener"]
    >[0][] = [];
    const release = observeProviderUsageMetrics({
      getConfig: () => config,
      listener: (snapshot) => snapshots.push(snapshot),
      refreshIntervalMs: 3_600_000,
    });
    try {
      await vi.waitFor(() => {
        expect(snapshots.at(-1)?.providers).toEqual([
          {
            provider: "openai",
            windows: [],
            lastAttemptTimestampSeconds: 1,
            refreshSuccess: false,
            refreshOutcome: "auth",
          },
        ]);
      });
    } finally {
      release();
    }
  });

  it("classifies a token rate-limit error as rate limiting", async () => {
    mocks.loadSummary.mockRejectedValueOnce(new Error("token rate limit exceeded"));
    const snapshots: Parameters<
      Parameters<typeof observeProviderUsageMetrics>[0]["listener"]
    >[0][] = [];
    const release = observeProviderUsageMetrics({
      getConfig: () => config,
      listener: (snapshot) => snapshots.push(snapshot),
      refreshIntervalMs: 3_600_000,
    });
    try {
      await vi.waitFor(() => {
        expect(snapshots.at(-1)?.providers[0]?.refreshOutcome).toBe("rate_limit");
      });
    } finally {
      release();
    }
  });

  it("withdraws allowance metrics until a changed credential selection succeeds", async () => {
    const snapshots: Parameters<
      Parameters<typeof observeProviderUsageMetrics>[0]["listener"]
    >[0][] = [];
    const release = observeProviderUsageMetrics({
      getConfig: () => config,
      listener: (snapshot) => snapshots.push(snapshot),
      refreshIntervalMs: 3_600_000,
    });
    try {
      await vi.waitFor(() => {
        expect(snapshots.at(-1)?.providers[0]?.windows).toEqual([{ window: "5h", usedRatio: 0.1 }]);
      });

      const agentId = resolveDefaultAgentId(config);
      const agentDir = resolveAgentDir(config, agentId);
      store = createStore({ default: "access-two" });
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store }]);
      now += 1;
      await runCapableUsageStatus();

      expect(snapshots.some((snapshot) => snapshot.providers.length === 0)).toBe(true);
      await vi.waitFor(() => {
        expect(snapshots.at(-1)?.providers[0]?.windows).toEqual([{ window: "5h", usedRatio: 0.2 }]);
      });
    } finally {
      release();
    }
  });

  it("rejects metric publication from a superseded refresh generation", async () => {
    const stale = createDeferredCore<UsageSummary>();
    const current: UsageSummary = {
      updatedAt: 2_000,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "5h", usedPercent: 20 }],
        },
      ],
    };
    mocks.loadSummary.mockImplementationOnce(() => stale.promise).mockResolvedValueOnce(current);
    const snapshots: Parameters<
      Parameters<typeof observeProviderUsageMetrics>[0]["listener"]
    >[0][] = [];
    const release = observeProviderUsageMetrics({
      getConfig: () => config,
      listener: (snapshot) => snapshots.push(snapshot),
      refreshIntervalMs: 3_600_000,
    });
    try {
      await vi.waitFor(() => expect(mocks.loadSummary).toHaveBeenCalledTimes(1));
      clearModelAuthStatusUsageCache();
      await expect(runCapableUsageStatus()).resolves.toMatchObject({ refreshing: true });
      await vi.waitFor(() => {
        expect(snapshots.at(-1)?.providers[0]?.windows).toEqual([{ window: "5h", usedRatio: 0.2 }]);
      });

      stale.resolve({
        updatedAt: 1_000,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            windows: [{ label: "5h", usedPercent: 90 }],
          },
        ],
      });
      await stale.promise;
      await Promise.resolve();
      expect(snapshots.at(-1)?.providers[0]?.windows).toEqual([{ window: "5h", usedRatio: 0.2 }]);
    } finally {
      release();
      stale.resolve(current);
    }
  });

  it("resolves current runtime configuration for each observer refresh", async () => {
    const nextConfig = {
      ...config,
      models: { providers: { openai: { baseUrl: "https://next.example/v1", models: [] } } },
    } as OpenClawConfig;
    let currentConfig = config;
    const release = observeProviderUsageMetrics({
      getConfig: () => currentConfig,
      listener: () => {},
      refreshIntervalMs: 1,
    });
    try {
      await vi.waitFor(() => expect(mocks.loadSummary).toHaveBeenCalledTimes(1));
      currentConfig = nextConfig;
      await vi.waitFor(() => {
        expect(
          mocks.loadSummary.mock.calls.some(([options]) => Object.is(options.config, nextConfig)),
        ).toBe(true);
      });
    } finally {
      release();
    }
  });

  it("keeps the observer cadence anchored to refresh start time", async () => {
    vi.useFakeTimers();
    const firstRefresh = createDeferredCore<UsageSummary>();
    mocks.loadSummary
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockResolvedValue({ updatedAt: now, providers: [] });
    const release = observeProviderUsageMetrics({
      getConfig: () => config,
      listener: () => {},
      refreshIntervalMs: 1_000,
    });
    try {
      await vi.waitFor(() => expect(mocks.loadSummary).toHaveBeenCalledOnce());
      now += 750;
      firstRefresh.resolve({ updatedAt: now, providers: [] });
      await firstRefresh.promise;
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(249);
      expect(mocks.loadSummary).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(mocks.loadSummary).toHaveBeenCalledTimes(2));
    } finally {
      release();
      firstRefresh.resolve({ updatedAt: now, providers: [] });
      vi.useRealTimers();
    }
  });

  it("continues refreshing after the startup async-work scope closes", async () => {
    const startupScope = new AsyncWorkScope();
    let release: (() => void) | undefined;
    try {
      await startupScope.track(async () => {
        release = observeProviderUsageMetrics({
          getConfig: () => config,
          listener: () => {},
          refreshIntervalMs: 50,
        });
        await vi.waitFor(() => expect(mocks.loadSummary).toHaveBeenCalledOnce());
      });
      await startupScope.drain();

      await vi.waitFor(() => {
        expect(mocks.loadSummary.mock.calls.length).toBeGreaterThanOrEqual(2);
      });
    } finally {
      release?.();
    }
  });

  it("does not schedule provider requests after the observer is released", async () => {
    vi.useFakeTimers();
    const release = observeProviderUsageMetrics({
      getConfig: () => config,
      listener: () => {},
      refreshIntervalMs: 1_000,
    });
    try {
      await vi.waitFor(() => expect(mocks.loadSummary).toHaveBeenCalledOnce());
      const signal = mocks.loadSummary.mock.calls[0]?.[0].signal;
      expect(signal?.aborted).toBe(false);
      release();
      expect(signal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.loadSummary).toHaveBeenCalledOnce();
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it("does not register a listener when released during runtime snapshot loading", async () => {
    const pendingStore = createDeferredCore<AuthProfileStore>();
    mocks.ensureStore.mockImplementationOnce(() => pendingStore.promise);
    const releasedListener = vi.fn();
    const release = observeProviderUsageMetrics({
      getConfig: () => config,
      listener: releasedListener,
      refreshIntervalMs: 3_600_000,
    });

    release();
    pendingStore.resolve(store);
    await pendingStore.promise;
    await vi.waitFor(() => expect(mocks.ensureStore).toHaveBeenCalledOnce());

    let releaseActive: (() => void) | undefined;
    try {
      releaseActive = observeProviderUsageMetrics({
        getConfig: () => config,
        listener: () => {},
        refreshIntervalMs: 3_600_000,
      });
      await vi.waitFor(() => expect(mocks.loadSummary).toHaveBeenCalledOnce());
      expect(releasedListener).not.toHaveBeenCalled();
    } finally {
      releaseActive?.();
    }
  });

  it("preserves an independent usage.status refresh when observer authority is released", async () => {
    const observerPending = createDeferredCore<UsageSummary>();
    const rpcUsage: UsageSummary = {
      updatedAt: now,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "5h", usedPercent: 40 }],
        },
      ],
    };
    mocks.loadSummary
      .mockImplementationOnce(() => observerPending.promise)
      .mockResolvedValueOnce(rpcUsage);
    const release = observeProviderUsageMetrics({
      getConfig: () => config,
      listener: () => {},
      refreshIntervalMs: 3_600_000,
    });
    try {
      await vi.waitFor(() => expect(mocks.loadSummary).toHaveBeenCalledOnce());
      const observerSignal = mocks.loadSummary.mock.calls[0]?.[0].signal;
      expect(observerSignal?.aborted).toBe(false);

      await expect(runUsageStatus()).resolves.toEqual(rpcUsage);
      expect(mocks.loadSummary).toHaveBeenCalledTimes(2);
      expect(mocks.loadSummary.mock.calls[1]?.[0].signal).toBeUndefined();

      release();
      expect(observerSignal?.aborted).toBe(true);
      expect((await runUsageStatus()) as UsageSummary).toEqual(rpcUsage);
    } finally {
      release();
      observerPending.resolve(rpcUsage);
      await observerPending.promise;
    }
  });

  it("invalidates cached usage when the runtime config changes", async () => {
    const configFor = (baseUrl: string) =>
      ({ ...config, models: { providers: { openai: { baseUrl, models: [] } } } }) as OpenClawConfig;
    const first = configFor("https://one.example/v1");
    await expect(runCapableUsageStatus(first)).resolves.toMatchObject({ refreshing: true });
    await vi.waitFor(async () => {
      expect(
        ((await runCapableUsageStatus(first)) as { providers: unknown[] }).providers,
      ).toHaveLength(1);
    });
    expect(mocks.loadSummary).toHaveBeenCalledTimes(1);

    const second = configFor("https://two.example/v1");
    await expect(runCapableUsageStatus(second)).resolves.toMatchObject({ refreshing: true });
    await vi.waitFor(() => expect(mocks.loadSummary).toHaveBeenCalledTimes(2));
  });

  it("shares the credential-bound snapshot and invalidates it on rotation", async () => {
    await runUsageStatus();
    const usage = await readProviderUsage({
      ...(await getProviderUsageRuntimeSnapshot({ config })),
      now,
    });
    expect(usage.usageByProvider.get("openai")?.windows[0]?.usedPercent).toBe(10);
    expect(mocks.loadSummary).toHaveBeenCalledTimes(1);
    publishStore(createStore({ default: "access-two" }));
    await expect(runUsageStatus()).resolves.toMatchObject({
      providers: [{ windows: [{ usedPercent: 20 }] }],
    });
    expect(mocks.loadSummary).toHaveBeenCalledTimes(2);
  });
});
