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
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  listProviderUsagePluginDescriptors: vi.fn(),
  loadProviderUsageSummary: vi.fn(),
}));

vi.mock("../../agents/auth-profiles.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/auth-profiles.js")>(
    "../../agents/auth-profiles.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore: mocks.ensureAuthProfileStore,
    externalCliDiscoveryForConfigStatus: vi.fn(() => undefined),
  };
});
vi.mock("../../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/provider-runtime.js")>(
    "../../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    listProviderUsagePluginDescriptors: mocks.listProviderUsagePluginDescriptors,
  };
});
vi.mock("../../infra/provider-usage.load.js", () => ({
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
}));

import {
  clearModelAuthStatusUsageCache,
  observeProviderUsageMetrics,
  readProviderUsageStaleWhileRevalidate,
} from "./models-auth-status-usage-cache.js";
import { getProviderUsageRuntimeSnapshot } from "./provider-usage-runtime.js";
import { usageHandlers } from "./usage.js";

const config: OpenClawConfig = { agents: { list: [{ id: "main", default: true }] } };
const refreshingCapableClient = { connect: { caps: ["usage-refreshing"] } };
const providerDescriptor = { provider: "openai", displayName: "OpenAI" };
const visibleProvider = { providers: [{ provider: "openai" }] };

function createStore(access = "access-one"): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "openai:default": {
        type: "oauth",
        provider: "openai",
        access,
        refresh: "refresh-one",
        expires: 1_000_000,
      },
    },
  };
}

async function runUsageStatus(params: { runtimeConfig?: OpenClawConfig; client?: unknown } = {}) {
  const respond = vi.fn();
  const handler = expectDefined(usageHandlers["usage.status"], "usage.status handler");
  await handler({
    respond,
    params: {},
    context: { getRuntimeConfig: () => params.runtimeConfig ?? config },
    client: params.client ?? null,
  } as unknown as Parameters<(typeof usageHandlers)["usage.status"]>[0]);
  expect(respond).toHaveBeenCalledTimes(1);
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  return expectDefined(respond.mock.calls[0]?.[1], "usage.status result");
}

function runCapableUsageStatus(runtimeConfig = config) {
  return runUsageStatus({ runtimeConfig, client: refreshingCapableClient });
}

async function settledStatus(client: unknown = refreshingCapableClient) {
  const scope = new AsyncWorkScope();
  try {
    return await scope.track(() => runUsageStatus({ client }));
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
    mocks.ensureAuthProfileStore.mockImplementation(() => store);
    mocks.listProviderUsagePluginDescriptors.mockReturnValue([providerDescriptor]);
    mocks.loadProviderUsageSummary.mockImplementation(async () => ({
      updatedAt: now,
      providers: [
        {
          ...providerDescriptor,
          windows: [
            { label: "5h", usedPercent: mocks.loadProviderUsageSummary.mock.calls.length * 10 },
          ],
          plan: "Plus",
        },
      ],
    }));
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("hands the exact runtime config to the background refresh", async () => {
    mocks.loadProviderUsageSummary.mockImplementation(async (options) => ({
      updatedAt: now,
      providers:
        options.config === config
          ? [
              {
                ...providerDescriptor,
                windows: [{ label: "5h", usedPercent: 25 }],
                accountEmail: "configured@example.com",
              },
            ]
          : [],
    }));
    await expect(settledStatus()).resolves.toMatchObject({ refreshing: true });
    await expect(runCapableUsageStatus()).resolves.toMatchObject({
      providers: [{ accountEmail: "configured@example.com" }],
    });
  });

  it("returns a cold marker only to capable clients and retains invalidated refresh work", async () => {
    const scope = new AsyncWorkScope();
    const heldRefresh = createDeferredCore<UsageSummary>();
    const original: UsageSummary = { updatedAt: now, providers: [] };
    let legacy: Promise<unknown> | undefined;
    let draining: Promise<void> | undefined;
    mocks.loadProviderUsageSummary.mockImplementationOnce(() => heldRefresh.promise);
    try {
      await expect(scope.track(runCapableUsageStatus)).resolves.toEqual({
        updatedAt: now,
        providers: [],
        refreshing: true,
      });
      // The blocking reader must not own the detached capable-client refresh.
      const legacyResponded = vi.fn();
      legacy = runUsageStatus();
      void legacy.then(legacyResponded, legacyResponded);
      clearModelAuthStatusUsageCache();
      const current = (await runUsageStatus()) as UsageSummary;
      expect(current.providers[0]?.windows[0]?.usedPercent).toBe(20);
      expect(legacyResponded).not.toHaveBeenCalled();

      let drained = false;
      draining = scope.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      heldRefresh.resolve(original);
      await expect(legacy).resolves.toEqual(original);
      await draining;
      expect(drained).toBe(true);
      await expect(runUsageStatus()).resolves.toEqual(current);
      expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
    } finally {
      heldRefresh.resolve(original);
      await Promise.allSettled([legacy, mocks.loadProviderUsageSummary.mock.results[0]?.value]);
      await (draining ?? scope.drain());
    }
  });

  it("keeps serving usage while run bookkeeping refreshes the runtime snapshot", async () => {
    await expect(settledStatus()).resolves.toMatchObject({ refreshing: true });
    await expect(runCapableUsageStatus()).resolves.toMatchObject(visibleProvider);
    publishStore({ ...store, usageStats: { "openai:default": { lastUsed: now } } });
    now += 1;
    await expect(runCapableUsageStatus()).resolves.toMatchObject(visibleProvider);
    await expect(runCapableUsageStatus()).resolves.toMatchObject(visibleProvider);
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(1);
  });

  it("refreshes when usage bookkeeping changes the selected profile", async () => {
    publishStore({
      version: 1,
      profiles: Object.fromEntries(
        ["first", "second"].map((id) => [
          `openai:${id}`,
          expectDefined(
            createStore(`access-${id}`).profiles["openai:default"],
            `${id} auth profile`,
          ),
        ]),
      ),
      usageStats: { "openai:first": { lastUsed: 100 }, "openai:second": { lastUsed: 200 } },
    });
    await expect(settledStatus()).resolves.toMatchObject({ refreshing: true });
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(1);
    publishStore({
      ...store,
      usageStats: { "openai:first": { lastUsed: 300 }, "openai:second": { lastUsed: 200 } },
    });
    now += 1;
    await expect(settledStatus()).resolves.toMatchObject({ refreshing: true });
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
    await expect(runCapableUsageStatus()).resolves.toMatchObject(visibleProvider);
    await expect(runCapableUsageStatus()).resolves.toMatchObject(visibleProvider);
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed refresh incomplete for capable clients and recovers", async () => {
    mocks.loadProviderUsageSummary.mockRejectedValueOnce(new Error("provider stack down"));
    await expect(settledStatus()).resolves.toMatchObject({ refreshing: true });
    await expect(settledStatus()).resolves.toMatchObject({ refreshing: true });
    await expect(runCapableUsageStatus()).resolves.toMatchObject({
      providers: [expect.any(Object)],
    });
  });

  it("rebuilds prepared usage facts once for each config and plugin generation", async () => {
    await runUsageStatus();
    await runUsageStatus();
    const nextConfig = { ...config };
    await runUsageStatus({ runtimeConfig: nextConfig });
    await runUsageStatus({ runtimeConfig: nextConfig });
    setActivePluginRegistry(createEmptyPluginRegistry());
    await runUsageStatus({ runtimeConfig: nextConfig });
    await runUsageStatus({ runtimeConfig: nextConfig });
    expect(mocks.listProviderUsagePluginDescriptors).toHaveBeenCalledTimes(3);
    expect(mocks.ensureAuthProfileStore).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])("serves stale usage while refreshing (timeout: %s)", async (timeout) => {
    const first = (await runUsageStatus()) as UsageSummary;
    now = 61_000;
    if (timeout) {
      mocks.loadProviderUsageSummary.mockResolvedValueOnce({
        updatedAt: now,
        providers: [{ ...providerDescriptor, windows: [], error: "Timeout" }],
      });
    }
    expect(JSON.stringify(await settledStatus(null))).toBe(JSON.stringify(first));
    now = 62_000;
    const retained = (await runUsageStatus()) as UsageSummary;
    expect(retained).toEqual(
      timeout
        ? first
        : {
            updatedAt: 61_000,
            providers: [
              {
                ...providerDescriptor,
                windows: [{ label: "5h", usedPercent: 20 }],
                plan: "Plus",
              },
            ],
          },
    );
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
  });
  it("observes sanitized cache-owned allowance metrics and retains them across timeouts", async () => {
    await runUsageStatus();
    now = 61_000;
    mocks.loadProviderUsageSummary.mockResolvedValueOnce({
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
      expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
    } finally {
      release();
    }
  });

  it("preserves distinct bounded identities for provider token windows", async () => {
    mocks.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: now,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [
            { label: "Tokens (6h)", usedPercent: 32, resetAt: 1_700_003_600_000 },
            { label: "Tokens (15m)", usedPercent: 8, resetAt: 1_700_000_900_000 },
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
        ]);
      });
    } finally {
      release();
    }
  });

  it("classifies a refresh exception as a failed provider observation", async () => {
    mocks.loadProviderUsageSummary.mockRejectedValueOnce(new Error("401 Unauthorized"));
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
      store = createStore("access-two");
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
    mocks.loadProviderUsageSummary
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(current);
    const snapshots: Parameters<
      Parameters<typeof observeProviderUsageMetrics>[0]["listener"]
    >[0][] = [];
    const release = observeProviderUsageMetrics({
      getConfig: () => config,
      listener: (snapshot) => snapshots.push(snapshot),
      refreshIntervalMs: 3_600_000,
    });
    try {
      await vi.waitFor(() => expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(1));
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
      await vi.waitFor(() => expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(1));
      currentConfig = nextConfig;
      await vi.waitFor(() => {
        expect(
          mocks.loadProviderUsageSummary.mock.calls.some(([options]) =>
            Object.is(options.config, nextConfig),
          ),
        ).toBe(true);
      });
    } finally {
      release();
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
      await vi.waitFor(() => expect(mocks.loadProviderUsageSummary).toHaveBeenCalledOnce());
      const signal = mocks.loadProviderUsageSummary.mock.calls[0]?.[0].signal;
      expect(signal?.aborted).toBe(false);
      release();
      expect(signal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.loadProviderUsageSummary).toHaveBeenCalledOnce();
    } finally {
      release();
      vi.useRealTimers();
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
    mocks.loadProviderUsageSummary
      .mockImplementationOnce(() => observerPending.promise)
      .mockResolvedValueOnce(rpcUsage);
    const release = observeProviderUsageMetrics({
      getConfig: () => config,
      listener: () => {},
      refreshIntervalMs: 3_600_000,
    });
    try {
      await vi.waitFor(() => expect(mocks.loadProviderUsageSummary).toHaveBeenCalledOnce());
      const observerSignal = mocks.loadProviderUsageSummary.mock.calls[0]?.[0].signal;
      expect(observerSignal?.aborted).toBe(false);

      await expect(runUsageStatus()).resolves.toEqual(rpcUsage);
      expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
      expect(mocks.loadProviderUsageSummary.mock.calls[1]?.[0].signal).toBeUndefined();

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
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(1);

    const second = configFor("https://two.example/v1");
    await expect(runCapableUsageStatus(second)).resolves.toMatchObject({ refreshing: true });
    await vi.waitFor(() => expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2));
  });

  it("shares the raw snapshot with models.authStatus and invalidates on credential rotation", async () => {
    await runUsageStatus();
    const usage = readProviderUsageStaleWhileRevalidate({
      ...getProviderUsageRuntimeSnapshot({ config }),
      now,
    });
    expect(usage.get("openai")?.windows[0]?.usedPercent).toBe(10);
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(1);
    publishStore(createStore("access-two"));
    await expect(runUsageStatus()).resolves.toMatchObject({
      providers: [{ windows: [{ usedPercent: 20 }] }],
    });
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
  });
});
