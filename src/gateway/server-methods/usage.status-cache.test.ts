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

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStoreAsync: vi.fn(),
  listProviderUsagePluginDescriptors: vi.fn(),
  loadProviderUsageSummary: vi.fn(),
}));

vi.mock("../../agents/auth-profiles.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/auth-profiles.js")>(
    "../../agents/auth-profiles.js",
  );
  return {
    ...actual,
    ensureAuthProfileStoreAsync: mocks.ensureAuthProfileStoreAsync,
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
  readProviderUsageStaleWhileRevalidate,
} from "./models-auth-status-usage-cache.js";
import { getProviderUsageRuntimeSnapshot } from "./provider-usage-runtime.js";
import { usageHandlers } from "./usage.js";

const config: OpenClawConfig = { agents: { entries: { main: {} } } };
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

function runCapableUsageStatus() {
  return runUsageStatus({ client: refreshingCapableClient });
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
    mocks.ensureAuthProfileStoreAsync.mockImplementation(() => store);
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

  it("returns a cold marker only to capable clients and retains invalidated refresh work", async () => {
    const scope = new AsyncWorkScope();
    const heldRefresh = createDeferredCore<UsageSummary>();
    const original: UsageSummary = { updatedAt: now, providers: [] };
    let draining: Promise<void> | undefined;
    mocks.loadProviderUsageSummary.mockImplementationOnce(() => heldRefresh.promise);
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
      expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
    } finally {
      heldRefresh.resolve(original);
      await Promise.allSettled([mocks.loadProviderUsageSummary.mock.results[0]?.value]);
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
  it("shares the credential-bound snapshot and invalidates it on rotation", async () => {
    await runUsageStatus();
    const usage = readProviderUsageStaleWhileRevalidate({
      ...(await getProviderUsageRuntimeSnapshot({ config })),
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
