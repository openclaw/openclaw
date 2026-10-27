import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createPreparedAccountCatalogAccess } from "../agents/prepared-model-runtime.catalog-auth.js";
import {
  notifyPreparedModelRuntimePublication,
  registerPreparedModelRuntimePublicationListener,
} from "../agents/prepared-model-runtime.publication-events.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getSessionCostUsageUpdatedAt,
  publishSessionCostUsageUpdated,
} from "../infra/session-cost-usage-events.js";
import { publishOperatorRoleConfigChange } from "./operator-role-policy.js";
import { createPreparedReadHandler } from "./server-methods/prepared-read.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./server-methods/types.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";
import { dispatchSharedRead, invalidateSharedReadResponses } from "./shared-read-responses.js";

const mocks = vi.hoisted(() => ({
  createRuntime: vi.fn(),
  fail: vi.fn(),
  invalidate: vi.fn(),
  read: vi.fn(),
  readStartup: vi.fn(),
  refresh: vi.fn(),
  stop: vi.fn(),
  registerAuthListener: vi.fn(),
  registerModelListener: vi.fn(),
  registerSkillsListener: vi.fn(),
  unregisterAuthListener: vi.fn(),
  unregisterModelListener: vi.fn(),
  unregisterSkillsListener: vi.fn(),
}));

vi.mock("./server-methods/chat-metadata-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-methods/chat-metadata-runtime.js")>()),
  createGatewayChatMetadataRuntime: mocks.createRuntime,
}));
vi.mock("../agents/auth-profiles/runtime-snapshots.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles/runtime-snapshots.js")>()),
  registerRuntimeAuthProfileStoreMutationListener: mocks.registerAuthListener,
}));
vi.mock("../agents/prepared-model-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/prepared-model-runtime.js")>()),
  registerPreparedModelRuntimePublicationListener: mocks.registerModelListener,
}));
vi.mock("../skills/runtime/refresh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills/runtime/refresh.js")>()),
  registerSkillsChangeListener: mocks.registerSkillsListener,
}));

const { createGatewayChatMetadataLifecycle } = await import("./server-chat-metadata-lifecycle.js");
const { ChatMetadataSnapshotUnavailableError } =
  await import("./server-methods/chat-metadata-facts.js");

const config = {} as OpenClawConfig;
const context = {} as GatewayRequestContext;
const sidecarOwners = new Set<ReturnType<typeof createGatewaySidecarStopOwner>>();

afterEach(async () => {
  for (const owner of sidecarOwners) {
    await owner.stop();
  }
  sidecarOwners.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.createRuntime.mockReturnValue({
    fail: mocks.fail,
    invalidate: mocks.invalidate,
    read: mocks.read,
    readStartup: mocks.readStartup,
    refresh: mocks.refresh,
    stop: mocks.stop,
  });
  mocks.refresh.mockResolvedValue(undefined);
  mocks.registerAuthListener.mockReturnValue(mocks.unregisterAuthListener);
  mocks.registerModelListener.mockReturnValue(mocks.unregisterModelListener);
  mocks.registerSkillsListener.mockReturnValue(mocks.unregisterSkillsListener);
});

function createLifecycle(warn = vi.fn()) {
  const sidecarOwner = createGatewaySidecarStopOwner();
  sidecarOwners.add(sidecarOwner);
  return {
    lifecycle: createGatewayChatMetadataLifecycle({
      getConfig: () => config,
      log: { warn } as never,
    }),
    sidecarOwner,
    warn,
  };
}

async function attachLifecycle(overrides: Partial<GatewayRequestContext> = {}) {
  const fixture = createLifecycle();
  const lifecycle = await fixture.lifecycle;
  const requestContext = { ...context, ...overrides };
  await lifecycle.attachContext(requestContext, fixture.sidecarOwner.publish);
  return { ...fixture, lifecycle, requestContext };
}

function expectMetadataBroadcast(broadcast: Mock, payload: Record<string, unknown>) {
  expect(broadcast).toHaveBeenCalledExactlyOnceWith("chat.metadata.changed", payload, {
    dropIfSlow: true,
  });
}

it("broadcasts only downgrade onset and recovery for alternating service-tier responses", async () => {
  vi.useFakeTimers({ now: 1_000 });
  mocks.registerModelListener.mockImplementation(registerPreparedModelRuntimePublicationListener);
  const broadcast = vi.fn();
  await attachLifecycle({ broadcast });
  const retirement = new AbortController();
  const catalog = createPreparedAccountCatalogAccess(
    () => true,
    retirement.signal,
    {},
    () => {
      notifyPreparedModelRuntimePublication({
        phase: "catalog-observation",
        modelFactsChanged: false,
        agentId: "main",
      });
    },
  );
  try {
    const record = catalog.prepareServiceTierObserver({
      selectedCredential: { source: "direct", provider: "openai", identityKey: "direct:openai" },
    });
    const route = {
      modelId: "fixture-model",
      runtimeId: "openclaw",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      requestedTier: "ultrafast",
    };
    for (let index = 0; index < 100; index++) {
      record({ ...route, responseTier: index % 2 === 0 ? "priority" : "ultrafast" });
      vi.advanceTimersByTime(500);
    }
    const payload = {
      agentId: "main",
      modelCatalogChanged: true,
      authChanged: false,
      commandsChanged: false,
    };
    expectMetadataBroadcast(broadcast, payload);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenLastCalledWith("chat.metadata.changed", payload, {
      dropIfSlow: true,
    });
    vi.advanceTimersByTime(60_000);
    expect(broadcast).toHaveBeenCalledTimes(2);
  } finally {
    retirement.abort();
  }
});

it.each([false, true])(
  "publishes usage completion (failed: %s) without rebuilding metadata and retires its listener on stop",
  async (failed) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const broadcast = vi.fn();
    const { sidecarOwner } = await attachLifecycle({ broadcast });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    mocks.refresh.mockClear();
    expect(sidecarOwner.snapshot()).toHaveLength(1);
    publishSessionCostUsageUpdated("main", failed);
    if (!failed) {
      await vi.advanceTimersByTimeAsync(500);
    }
    expectMetadataBroadcast(broadcast, {
      agentId: "main",
      usageUpdatedAt: expect.any(Number),
      modelCatalogChanged: false,
      authChanged: false,
      commandsChanged: false,
      ...(failed ? { usageRefreshFailed: true } : {}),
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
    await sidecarOwner.stop();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.unregisterAuthListener).toHaveBeenCalledOnce();
    expect(mocks.unregisterModelListener).toHaveBeenCalledOnce();
    expect(mocks.unregisterSkillsListener).toHaveBeenCalledOnce();
    publishSessionCostUsageUpdated("main");
    expect(broadcast).toHaveBeenCalledTimes(1);
  },
);

it("coalesces usage batches by agent without delaying failures or extending the window", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const broadcast = vi.fn();
  const { sidecarOwner } = await attachLifecycle({ broadcast });
  for (let index = 0; index < 112; index++) {
    publishSessionCostUsageUpdated("main");
    publishSessionCostUsageUpdated("other");
  }
  const latestOther = getSessionCostUsageUpdatedAt();
  await vi.advanceTimersByTimeAsync(499);
  expect(broadcast).not.toHaveBeenCalled();
  publishSessionCostUsageUpdated("main");
  const latestMain = getSessionCostUsageUpdatedAt();
  await vi.advanceTimersByTimeAsync(1);
  expect(broadcast.mock.calls.map(([, payload]) => payload.agentId)).toEqual(["main", "other"]);
  expect(broadcast.mock.calls.map(([, payload]) => payload.usageUpdatedAt)).toEqual([
    latestMain,
    latestOther,
  ]);
  const firstCommit = broadcast.mock.calls[0]![1].usageUpdatedAt;
  broadcast.mockClear();

  publishSessionCostUsageUpdated("other");
  publishSessionCostUsageUpdated("main");
  publishSessionCostUsageUpdated("main", true);
  expect(broadcast.mock.calls.map(([, payload]) => payload.agentId)).toEqual(["main", "main"]);
  expect(broadcast.mock.calls.map(([, payload]) => payload.usageRefreshFailed ?? false)).toEqual([
    false,
    true,
  ]);
  expect(broadcast.mock.calls[0]![1].usageUpdatedAt).toBeGreaterThan(firstCommit);
  expect(broadcast.mock.calls[1]![1].usageUpdatedAt).toBeGreaterThan(
    broadcast.mock.calls[0]![1].usageUpdatedAt,
  );
  await vi.advanceTimersByTimeAsync(499);
  expect(broadcast).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(broadcast.mock.calls[2]![1].agentId).toBe("other");
  publishSessionCostUsageUpdated("main");
  await sidecarOwner.stop();
  await vi.advanceTimersByTimeAsync(500);
  expect(broadcast).toHaveBeenCalledTimes(3);
});

it("retires model choices at its config commit before pending metadata settles", async () => {
  const broadcast = vi.fn();
  let committedConfig: OpenClawConfig = { agents: { entries: { main: {} } } };
  const ownedContext = {
    ...context,
    broadcast,
    getCommittedRuntimeConfig: () => committedConfig,
  };
  const entered = createDeferred();
  const release = createDeferred();
  mocks.refresh.mockImplementationOnce(() => {
    entered.resolve();
    return release.promise;
  });
  const { lifecycle: pendingLifecycle, sidecarOwner } = createLifecycle();
  const lifecycle = await pendingLifecycle;
  const attaching = lifecycle.attachContext(ownedContext, sidecarOwner.publish);
  try {
    await entered.promise;
    publishOperatorRoleConfigChange({});
    expect(broadcast).not.toHaveBeenCalled();
    committedConfig = {
      ...committedConfig,
      auth: { profiles: { account: { provider: "fixture", mode: "api_key" } } },
    };
    publishOperatorRoleConfigChange(ownedContext);
    expect(broadcast).not.toHaveBeenCalled();
    committedConfig = { ...committedConfig, agents: { entries: { main: {}, "new-agent": {} } } };
    publishOperatorRoleConfigChange(ownedContext);
    expect(broadcast).not.toHaveBeenCalled();
    committedConfig = { ...committedConfig, models: { mode: "replace" } };
    publishOperatorRoleConfigChange(ownedContext);
    expectMetadataBroadcast(broadcast, { modelSelectionChanged: true, commandsChanged: false });
    broadcast.mockClear();
    committedConfig = {
      ...committedConfig,
      agents: { defaults: { modelPolicy: { allow: ["fixture/allowed"] } } },
    };
    publishOperatorRoleConfigChange(ownedContext);
    expectMetadataBroadcast(broadcast, { modelSelectionChanged: true, commandsChanged: false });
  } finally {
    release.resolve();
    await attaching;
    await sidecarOwner.stop();
  }
  broadcast.mockClear();
  publishOperatorRoleConfigChange(ownedContext);
  expect(broadcast).not.toHaveBeenCalled();
});

describe("gateway chat metadata lifecycle", () => {
  it("ignores watcher availability but refreshes published skill changes", async () => {
    await attachLifecycle();
    mocks.refresh.mockClear();
    const listener = mocks.registerSkillsListener.mock.calls[0]![0];
    listener({ reason: "watch-available" });
    expect(mocks.refresh).not.toHaveBeenCalled();
    listener({ reason: "watch" });
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("forwards settled runtime publications to connected clients", async () => {
    const broadcast = vi.fn();
    await attachLifecycle({ broadcast });
    const change = { modelCatalogChanged: true, authChanged: true, commandsChanged: false };
    mocks.createRuntime.mock.calls[0]![0].onChanged(change);
    expectMetadataBroadcast(broadcast, change);
  });

  it("joins runtime shutdown before releasing the Gateway sidecar", async () => {
    const release = createDeferred();
    mocks.stop.mockReturnValue(release.promise);
    const { sidecarOwner } = await attachLifecycle();
    let stopped = false;
    const stopping = sidecarOwner.stop().then(() => {
      stopped = true;
    });
    try {
      await nextEventLoopTurn();
      expect(mocks.stop).toHaveBeenCalledOnce();
      expect(stopped).toBe(false);
      release.resolve();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      release.resolve();
      await stopping;
    }
  });

  it.each(["build failed", "catalog during attachment", "owner invalidated"] as const)(
    "refreshes subordinate changes after %s catch-up",
    async (startup) => {
      const entered = createDeferred();
      const release = createDeferred();
      if (startup === "build failed") {
        mocks.refresh.mockRejectedValueOnce(new Error("metadata unavailable"));
      } else if (startup === "owner invalidated") {
        mocks.refresh.mockRejectedValueOnce(new ChatMetadataSnapshotUnavailableError());
      } else if (startup === "catalog during attachment") {
        mocks.refresh.mockImplementationOnce(() => {
          entered.resolve();
          return release.promise;
        });
      }
      const { lifecycle: pending, sidecarOwner, warn } = createLifecycle();
      const lifecycle = await pending;
      const attachment = lifecycle.attachContext(context, sidecarOwner.publish);
      try {
        if (startup === "catalog during attachment") {
          await entered.promise;
          expect(mocks.refresh).toHaveBeenCalledOnce();
          mocks.registerModelListener.mock.calls[0]![0]({ phase: "catalog-published" });
          release.resolve();
        }
        await expect(attachment).resolves.toBeUndefined();
        expect(mocks.refresh).toHaveBeenCalledOnce();
        if (startup === "build failed") {
          expect(warn).toHaveBeenCalledWith(
            "chat metadata catch-up refresh failed: Error: metadata unavailable",
          );
        } else {
          expect(warn).not.toHaveBeenCalled();
        }
        const modelListener = mocks.registerModelListener.mock.calls[0]![0];
        const authListener = mocks.registerAuthListener.mock.calls[0]![0];
        const skillsListener = mocks.registerSkillsListener.mock.calls[0]![0];
        if (startup === "owner invalidated") {
          modelListener({ phase: "invalidated" });
          const failure = new Error("owner publication failed");
          modelListener({ phase: "failed", error: failure });
          modelListener({ phase: "invalidated" });
          expect(mocks.fail).toHaveBeenCalledExactlyOnceWith(failure);
          expect(mocks.invalidate).toHaveBeenCalledOnce();
          modelListener({ phase: "catalog-published" });
          modelListener({ phase: "catalog-failed" });
          authListener();
          skillsListener({ reason: "watch" });
          expect(mocks.refresh).toHaveBeenCalledOnce();
          expect(warn).not.toHaveBeenCalled();
          modelListener({ phase: "published" });
          expect(mocks.refresh).toHaveBeenCalledTimes(2);
          expect(warn).not.toHaveBeenCalled();
        } else {
          authListener();
          expect(mocks.refresh).toHaveBeenCalledTimes(2);
          skillsListener({ reason: "watch" });
          expect(mocks.refresh).toHaveBeenCalledTimes(3);
        }
      } finally {
        release.resolve();
        await attachment;
      }
    },
  );

  it.each([
    ["catalog-observation", false, false, false],
    ["catalog-published", true, false, true],
    ["catalog-published", false, false, false],
    ["catalog-published", undefined, false, true],
    ["catalog-published", false, true, true],
    ["catalog-status", false, false, false],
  ] as const)(
    "refreshes catalog metadata only for a change (%s, facts=%s, status=%s)",
    async (phase, modelFactsChanged, refreshStatusChanged, refreshes) => {
      const { lifecycle: pendingLifecycle, sidecarOwner } = createLifecycle();
      const lifecycle = await pendingLifecycle;
      const requestContext = { ...context, broadcast: vi.fn(), getRuntimeConfig: () => config };
      let pending = true;
      let payloadJson: string | undefined;
      const produce = vi.fn(() => ({ pendingProviders: pending ? ["synthetic"] : undefined }));
      const handler = createPreparedReadHandler(() => ({
        run: (respond) => respond(true, produce()),
      }));
      const options = {
        req: { type: "req", id: "catalog", method: "models.list" },
        params: {},
        client: null,
        context: requestContext,
        isWebchatConnect: () => false,
        respond: (_ok, payload) => {
          payloadJson = JSON.stringify(payload);
        },
      } satisfies GatewayRequestHandlerOptions;
      const sharing = {
        shareKey: () => "catalog",
        shareInvalidationEvents: ["chat.metadata.changed"],
        shareMaxAgeMs: 1_000,
      };
      const read = () => dispatchSharedRead(handler, options, sharing, () => {});
      vi.useFakeTimers();
      try {
        await lifecycle.attachContext(requestContext, sidecarOwner.publish);
        const modelListener = mocks.registerModelListener.mock.calls[0]?.[0];
        modelListener({ phase: "published" });
        expect(mocks.refresh).toHaveBeenCalledTimes(2);
        mocks.invalidate.mockClear();
        await read();
        await read();
        expect(produce).toHaveBeenCalledOnce();
        expect(payloadJson).toBe('{"pendingProviders":["synthetic"]}');

        pending = false;
        modelListener({ phase, modelFactsChanged, refreshStatusChanged, agentId: "main" });
        await read();

        expect(payloadJson).toBe("{}");
        if (phase === "catalog-observation") {
          expectMetadataBroadcast(requestContext.broadcast, {
            agentId: "main",
            modelCatalogChanged: true,
            authChanged: false,
            commandsChanged: false,
          });
        }
        expect(produce).toHaveBeenCalledTimes(2);
        expect(mocks.invalidate).not.toHaveBeenCalled();
        expect(mocks.refresh).toHaveBeenCalledTimes(refreshes ? 3 : 2);
        if (refreshes) {
          expect(mocks.refresh).toHaveBeenLastCalledWith({
            notifyIfUnchanged: refreshStatusChanged,
          });
        }
      } finally {
        invalidateSharedReadResponses(requestContext.broadcast);
        vi.useRealTimers();
      }
    },
  );
});
