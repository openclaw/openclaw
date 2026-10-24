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

async function runUsageStatus(client: GatewayClient | null = null) {
  const [ok, payload] = usageReply(
    await invokeUsage("usage.status", {}, config, {
      client,
      context: { getRuntimeConfig: () => config },
    }),
  );
  expect(ok).toBe(true);
  return expectDefined(payload, "usage.status result");
}

function runCapableUsageStatus() {
  return runUsageStatus(refreshingCapableClient);
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
