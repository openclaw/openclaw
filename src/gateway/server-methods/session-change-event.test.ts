import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createSessionCapabilityHarness,
  sessionsResult,
} from "../../../ui/src/lib/sessions/session-capability.test-support.js";
import { resolveChatPaneDesktopTarget } from "../../../ui/src/pages/chat/chat-pane-placement.js";
import { createTestGatewayClient } from "../../../ui/src/test-helpers/gateway-client.js";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildProjectedAgentRunIndex,
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import type { RpcSourceRef } from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import { createSessionRowPlacementProjection } from "../session-row-placement-projection.js";
import {
  bindSessionRowProjection,
  getSessionRowProjection,
} from "../session-row-projection-access.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import { replaceSessionRowFacts } from "../session-utils-row.js";
import { claimRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { projectWorkerSessionPlacement } from "../worker-environments/placement-projector.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import {
  createActiveRpcSourceForTest,
  registerRpcSourceForTest,
} from "./rpc-source-fixtures.test-support.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  loadRow: vi.fn(),
  rowLabel: "first",
}));

vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => {
      const logger = actual.createSubsystemLogger(...args);
      return args[0] === "gateway/session-events" ? { ...logger, warn: mocks.warn } : logger;
    },
  };
});

const { emitSessionsChanged, flushPendingSessionsChangedEvents } =
  await import("./session-change-event.js");

async function emitAndSettleLeading(...args: Parameters<typeof emitSessionsChanged>) {
  emitSessionsChanged(...args);
  await vi.advanceTimersByTimeAsync(0);
}

function holdExactPreparation(projection: SessionRowProjection, ...ready: Promise<void>[]) {
  const prepare = projection.withPreparedExactRows.bind(projection);
  return vi
    .spyOn(projection, "withPreparedExactRows")
    .mockImplementation(async (queries, consume) => {
      await ready.shift();
      return prepare(queries, consume);
    });
}

function createContext(
  receivers = new Set(["conn-1"]),
  config: OpenClawConfig = {},
  sources: Iterable<readonly [string, RpcSourceRef]> = [],
) {
  setRuntimeConfigSnapshot(config);
  rpcSourceTesting.reset(sources);
  const projection = {
    get state() {
      return { rowContext: { projectedAgentRuns: buildProjectedAgentRunIndex() } };
    },
    ensureMaterialized: async () => {},
    withPreparedExactRows: async (_queries: unknown, consume: (read: unknown) => unknown) =>
      consume(projection),
    describe: ({ key, agentId }: { key: string; agentId: string }) => ({
      key,
      storeTarget: {
        storePath: resolveSessionStorePathCore(config.session?.store, { agentId }),
      },
    }),
    present: ({ key }: { key: string }) => mocks.loadRow(key),
  };
  return {
    broadcastToConnIds: vi.fn(),
    getRuntimeConfig: () => config,
    ...bindSessionRowProjection({}, () => projection as unknown as SessionRowProjection),
    getSessionEventSubscriberConnIds: () => receivers,
    mentionInbox: { invalidateAsync: vi.fn() },
  } as unknown as GatewayRequestContext;
}

function broadcasts(context: GatewayRequestContext) {
  return vi.mocked(context.broadcastToConnIds).mock.calls;
}

function fixedStoreConfig(retired = false): OpenClawConfig {
  return {
    session: { scope: "global", store: "/stores/shared.sqlite" },
    agents: {
      ownership: "explicit",
      defaults: { sessionStore: { agentId: "ops" } },
      entries: retired ? { research: {} } : { ops: {}, research: {} },
    },
  };
}

function activePlacement(
  sessionKey: string,
): Extract<WorkerSessionPlacementRecord, { state: "active" }> {
  return {
    sessionId: `${sessionKey}-id`,
    sessionKey,
    agentId: "main",
    state: "active",
    executionMode: "worker-turn",
    generation: 1,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    environmentId: "worker-first",
    activeOwnerEpoch: 1,
    workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
    remoteWorkspaceDir: "/workspace",
    workerBundleHash: "a".repeat(64),
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    turnClaim: {
      owner: "worker",
      claimId: "private-turn-claim",
      runId: "private-run",
      generation: 1,
      ownerEpoch: 1,
    },
  };
}

function preparePlacementProjection(
  context: GatewayRequestContext,
  sessionKey: string,
  placements: Map<string, WorkerSessionPlacementRecord>,
) {
  const projection = createSessionRowProjectionFixture({
    cfg: context.getRuntimeConfig(),
    agentId: "main",
    store: { [sessionKey]: { sessionId: `${sessionKey}-id`, updatedAt: 1 } },
  });
  bindSessionRowProjection(context, () => projection);
  onTestFinished(() => projection.dispose());
  const update = () => {
    const record = projection.describe({ key: sessionKey, agentId: "main" });
    if (!record) {
      throw new Error("missing resident placement row");
    }
    const placement = placements.get(record.entry.sessionId);
    // Simulate committed owner facts without reading the placement store during event snapshots.
    record.materialized = replaceSessionRowFacts(record.materialized, {
      placement: placement ? projectWorkerSessionPlacement(placement) : undefined,
    });
  };
  update();
  return { update };
}

beforeEach((context) => {
  vi.useFakeTimers();
  // Publication budgets must advance on the same clock as debounce timers.
  const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  context.onTestFinished(() => {
    clock.mockRestore();
  });
  mocks.loadRow.mockReset().mockImplementation((key: string) => ({
    key,
    label: mocks.rowLabel,
    sessionId: `${key}-id`,
  }));
  mocks.rowLabel = "first";
});

afterEach(async () => {
  await flushPendingSessionsChangedEvents();
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
});

describe("sessions.changed coalescing", () => {
  it("publishes catalog-only changes without invalidating session projections or access", async () => {
    const context = createContext();
    const changed = vi.fn();
    const unsubscribe = sessionChanges.subscribe(changed);
    onTestFinished(unsubscribe);
    const initialAccessRevision = readGatewayAccessRevision();

    await emitAndSettleLeading(context, { reason: "groups" }, { catalogOnly: true });

    expect(changed).not.toHaveBeenCalled();
    expect(context.mentionInbox?.invalidateAsync).not.toHaveBeenCalled();
    expect(readGatewayAccessRevision()).toBe(initialAccessRevision);
    expect(context.broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ reason: "groups" }),
      expect.any(Set),
      expect.any(Object),
    );

    // Rename/delete use the same public reason but can change member rows.
    await emitAndSettleLeading(context, { reason: "groups" });
    expect(changed).toHaveBeenCalledWith({ all: true, scope: "sessions" });
    expect(context.mentionInbox?.invalidateAsync).toHaveBeenCalledOnce();
    expect(readGatewayAccessRevision()).toBe(initialAccessRevision + 1);
  });

  it("makes the session desktop ready during roster backoff and fences late list responses", async () => {
    const context = createContext();
    const sessionKey = "agent:main:cloud";
    const first = activePlacement(sessionKey);
    const placements = new Map<string, WorkerSessionPlacementRecord>([[first.sessionId, first]]);
    context.workerSessionPlacementService = { getMany: () => placements };
    const resident = preparePlacementProjection(context, sessionKey, placements);
    const initial = sessionsResult(
      [
        {
          key: sessionKey,
          sessionId: first.sessionId,
          kind: "direct",
          updatedAt: 1,
          placement: {
            state: "requested",
            generation: 0,
            createdAtMs: 1,
            updatedAtMs: 1,
            stateChangedAtMs: 1,
          },
        },
      ],
      1,
    );
    let response = Promise.resolve(initial);
    const request = vi.fn(async () => response);
    const client = createTestGatewayClient(request);
    const { sessions, emitEvent } = createSessionCapabilityHarness(client.request.bind(client));
    const row = () => sessions.state.result?.sessions.find((session) => session.key === sessionKey);
    const frames: string[] = [];
    vi.mocked(context.broadcastToConnIds).mockImplementation((event, payload) => {
      const frame = JSON.stringify({ type: "event", event, payload });
      frames.push(frame);
      emitEvent(JSON.parse(frame));
    });
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const slow = createDeferred<typeof initial>();
      response = slow.promise;
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: { sessionKey, reason: "patch" },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(6_000);
      slow.resolve(initial);
      await vi.advanceTimersByTimeAsync(0);
      const readsBeforePlacement = request.mock.calls.length;

      resident.update();
      await emitAndSettleLeading(context, { reason: "placement", sessionKey });
      expect(resolveChatPaneDesktopTarget(row())).toBe("worker-first");
      expect(request).toHaveBeenCalledTimes(readsBeforePlacement);
      const stale = createDeferred<typeof initial>();
      response = stale.promise;
      const oldRefresh = sessions.refresh({ agentId: "main", force: true });

      placements.set(first.sessionId, {
        ...first,
        state: "draining",
        generation: 2,
        turnClaim: null,
      });
      resident.update();
      await emitAndSettleLeading(context, { reason: "placement", sessionKey });
      await flushPendingSessionsChangedEvents(context);
      expect(resolveChatPaneDesktopTarget(row())).toBeNull();
      placements.set(first.sessionId, {
        ...first,
        generation: 3,
        environmentId: "worker-replacement",
      });
      resident.update();
      await emitAndSettleLeading(context, { reason: "placement", sessionKey });
      expect(resolveChatPaneDesktopTarget(row())).toBe("worker-replacement");
      stale.resolve(initial);
      await oldRefresh;
      expect(resolveChatPaneDesktopTarget(row())).toBe("worker-replacement");

      placements.clear();
      resident.update();
      await emitAndSettleLeading(context, { reason: "placement", sessionKey });
      await flushPendingSessionsChangedEvents(context);
      expect(row()).not.toHaveProperty("placement");
      expect(row()).not.toHaveProperty("placementMove");
      expect(frames.join("\n")).not.toContain('"turnClaim"');
      expect(frames.join("\n")).not.toContain("private-turn-claim");
    } finally {
      sessions.dispose();
    }
  });

  it.each(["before", "during"])(
    "publishes a 20-session burst when its producer drains %s preparation",
    async (when) => {
      vi.useRealTimers();
      mocks.warn.mockClear();
      const context = createContext();
      const keys = Array.from({ length: 20 }, (_, index) => `agent:main:burst-${index}`);
      const projection = createSessionRowProjectionFixture({
        cfg: context.getRuntimeConfig(),
        store: Object.fromEntries(
          keys.map((key) => [key, { sessionId: key, updatedAt: 1, label: "committed" }]),
        ),
      });
      bindSessionRowProjection(context, () => projection);
      const entered = createDeferred();
      const release = createDeferred();
      let ready = false;
      const preparation = release.promise.then(() => {
        ready = true;
      });
      const binding = new AsyncLocalStorage<string>();
      const preparationBindings = new Set<string | undefined>();
      const placement = createSessionRowPlacementProjection(undefined, () => {
        preparationBindings.add(binding.getStore());
        entered.resolve();
        return ready ? undefined : preparation;
      });
      projection.withPreparedExactRows = (queries, consume) =>
        placement.withPreparedRows(
          projection,
          () => true,
          (query) => projection.capture(query),
          queries,
          () => undefined,
          consume,
        );
      const producer = new AsyncWorkScope();
      try {
        binding.run("publisher", () =>
          producer.run(() => {
            for (const sessionKey of keys) {
              emitSessionsChanged(context, { reason: "patch", sessionKey });
            }
          }),
        );
        if (when === "during") {
          await entered.promise;
        }
        await producer.drain();
        release.resolve();
        await flushPendingSessionsChangedEvents(context);
        expect(mocks.warn).not.toHaveBeenCalled();
        expect(preparationBindings).toEqual(new Set(["publisher"]));
        expect(broadcasts(context).map(([, payload]) => payload)).toEqual(
          keys.map((sessionKey) =>
            expect.objectContaining({
              sessionKey,
              session: expect.objectContaining({ key: sessionKey, label: "committed" }),
            }),
          ),
        );
      } finally {
        release.resolve();
        await flushPendingSessionsChangedEvents(context);
        placement.dispose();
        projection.dispose();
      }
    },
  );

  it("publishes an exact row while unrelated bulk preparation is blocked", async () => {
    const context = createContext();
    const projection = getSessionRowProjection(context)!;
    const unrelated = createDeferred();
    const bulk = vi.spyOn(projection, "ensureMaterialized").mockReturnValue(unrelated.promise);
    const bulkWork = projection.ensureMaterialized();
    const sessionKey = "agent:main:ready";
    try {
      await emitAndSettleLeading(context, { reason: "patch", sessionKey });
      expect(broadcasts(context)).toMatchObject([
        [
          "sessions.changed",
          { session: { key: sessionKey, sessionId: `${sessionKey}-id`, label: "first" } },
          new Set(["conn-1"]),
          { sessionKeys: [sessionKey] },
        ],
      ]);
      expect(broadcasts(context)[0]?.[2]).toEqual(new Set(["conn-1"]));
      expect(bulk).toHaveBeenCalledOnce();
    } finally {
      unrelated.resolve();
      await bulkWork;
      await flushPendingSessionsChangedEvents(context);
    }
  });

  it("joins the latest deferred row during shutdown while preparation is blocked", async () => {
    const context = createContext();
    const prepared = createDeferred();
    holdExactPreparation(getSessionRowProjection(context)!, prepared.promise);
    emitSessionsChanged(context, { reason: "first", sessionKey: "agent:main:chat" });
    await Promise.resolve();
    emitSessionsChanged(context, { reason: "latest", sessionKey: "agent:main:chat" });
    await vi.advanceTimersByTimeAsync(100);
    let drained = false;
    const drain = flushPendingSessionsChangedEvents(context).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
    mocks.rowLabel = "committed-latest";
    prepared.resolve();
    await drain;
    expect(broadcasts(context).map(([, payload]) => payload)).toMatchObject([
      { reason: "first", session: { label: "committed-latest" } },
      { reason: "latest", session: { label: "committed-latest" } },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an alias tombstone behind an admitted row publication", async () => {
    const context = createContext(new Set(["conn-1"]), {
      agents: { entries: { main: {} } },
    });
    const prepared = createDeferred();
    holdExactPreparation(getSessionRowProjection(context)!, prepared.promise);
    emitSessionsChanged(context, {
      reason: "patch",
      sessionKey: "main",
      agentId: "main",
      sessionId: "removed",
    });
    await Promise.resolve();
    emitSessionsChanged(context, {
      reason: "delete",
      sessionKey: "agent:main:main",
      agentId: "main",
      sessionId: "removed",
    });
    await vi.advanceTimersByTimeAsync(0);
    const earlyPublications = broadcasts(context).length;
    prepared.resolve();
    await flushPendingSessionsChangedEvents(context);
    expect(earlyPublications).toBe(0);
    expect(broadcasts(context).map(([event, payload]) => [event, payload])).toMatchObject([
      ["sessions.changed", { reason: "patch", sessionId: "removed" }],
      ["socket.drain", { reason: "delete", sessionId: "removed" }],
      ["sessions.changed", { reason: "delete", sessionId: "removed" }],
    ]);
  });

  it.each([
    { key: "main", agentId: "main", subscriptionKey: "agent:main:main" },
    { key: "global", agentId: "work", subscriptionKey: "agent:work:global" },
  ])(
    "routes $key teardown to message-only subscribers for $agentId",
    async ({ key, agentId, subscriptionKey }) => {
      const context = createContext(new Set(), {
        agents: { ownership: "explicit", entries: { main: {}, work: {} } },
      });
      context.getSessionMessageSubscriberConnIds = vi.fn(
        (requestedKey) => new Set(requestedKey === subscriptionKey ? ["message-reader"] : []),
      );

      await emitAndSettleLeading(context, { reason: "reset", sessionKey: key, agentId });
      await flushPendingSessionsChangedEvents(context);

      expect(context.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
        "socket.drain",
        expect.objectContaining({ sessionKey: key, agentId, reason: "reset" }),
        new Set(["message-reader"]),
        expect.objectContaining({ agentId, dropIfSlow: false }),
      );
    },
  );

  it("sends one drain notice to the union of list and message subscribers", async () => {
    const context = createContext(new Set(["list-reader", "both"]));
    context.getSessionMessageSubscriberConnIds = () => new Set(["message-reader", "both"]);

    await emitAndSettleLeading(context, { reason: "reset", sessionKey: "agent:main:main" });
    await flushPendingSessionsChangedEvents(context);

    const drains = broadcasts(context).filter(([event]) => event === "socket.drain");
    expect(drains).toHaveLength(1);
    expect(drains[0]?.[2]).toEqual(new Set(["list-reader", "message-reader", "both"]));
  });

  it("joins a different session admitted while shutdown is draining", async () => {
    const context = createContext();
    const first = createDeferred();
    const second = createDeferred();
    holdExactPreparation(getSessionRowProjection(context)!, first.promise, second.promise);
    emitSessionsChanged(context, { reason: "patch", sessionKey: "agent:main:first" });
    await Promise.resolve();
    let drained = false;
    const drain = flushPendingSessionsChangedEvents(context).then(() => {
      drained = true;
    });
    emitSessionsChanged(context, { reason: "patch", sessionKey: "agent:main:second" });
    await Promise.resolve();
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const drainedBeforeSecond = drained;
    second.resolve();
    await drain;
    expect(drainedBeforeSecond).toBe(false);
    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("emits a leading row and one trailing row with the latest state", async () => {
    const context = createContext();
    const initialAccessRevision = readGatewayAccessRevision();

    await emitAndSettleLeading(context, { reason: "create", sessionKey: "agent:main:chat" });
    mocks.rowLabel = "latest";
    await emitAndSettleLeading(context, {
      reason: "patch",
      sessionKey: "agent:main:chat",
      catalogChanged: true,
    });
    await emitAndSettleLeading(context, { reason: "send", sessionKey: "agent:main:chat" });

    expect(context.broadcastToConnIds).toHaveBeenCalledOnce();
    expect(mocks.loadRow).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);

    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(2);
    expect(mocks.loadRow).toHaveBeenCalledTimes(2);
    expect(broadcasts(context)[1]?.[1]).toMatchObject({
      label: "latest",
      reason: "send",
      catalogChanged: true,
    });
    expect(readGatewayAccessRevision()).toBe(initialAccessRevision + 3);
    await emitAndSettleLeading(context, { reason: "patch", sessionKey: "agent:main:chat" });
    expect(broadcasts(context).at(-1)?.[1]).not.toHaveProperty("catalogChanged");
  });

  it("refreshes metadata projections without expiring access when nobody receives events", async () => {
    const context = createContext(new Set());
    const sessionKey = "agent:main:metadata";
    const initialAccessRevision = readGatewayAccessRevision();
    await emitAndSettleLeading(context, { reason: "patch", sessionKey }, { accessChanged: false });

    expect(readGatewayAccessRevision()).toBe(initialAccessRevision);
    expect(context.mentionInbox?.invalidateAsync).toHaveBeenCalledOnce();
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
    expect(mocks.loadRow).not.toHaveBeenCalled();
  });

  it("emits the latest trailing row by the sustained-mutation deadline", async () => {
    const context = createContext();
    const sessionKey = "agent:main:chat";

    await emitAndSettleLeading(context, { reason: "leading", sessionKey });
    await emitAndSettleLeading(context, { reason: "update-0", sessionKey });
    for (let index = 1; index <= 5; index += 1) {
      await vi.advanceTimersByTimeAsync(90);
      mocks.rowLabel = `state-${index}`;
      await emitAndSettleLeading(context, { reason: `update-${index}`, sessionKey });
    }

    await vi.advanceTimersByTimeAsync(49);
    expect(context.broadcastToConnIds).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(2);
    expect(broadcasts(context)[1]?.[1]).toMatchObject({
      label: "state-5",
      reason: "update-5",
    });
  });

  it("does not adopt the compatibility owner's ownerless run for another agent", async () => {
    const config: OpenClawConfig = retainLegacyDefaultAgentId(
      {
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      } satisfies OpenClawConfig,
      "ops",
    );
    const sessionId = "agent:research:shared-session-id";
    const context = createContext(
      new Set(["conn-1"]),
      config,
      new Map([
        [
          "compat-owner-run",
          await createActiveRpcSourceForTest(
            {},
            {
              sessionId,
              sessionKey: "legacy-unscoped",
              storeScope: resolveSessionStorePathCore(config.session?.store, { agentId: "ops" }),
            },
          ),
        ],
      ]),
    );

    await emitAndSettleLeading(context, {
      reason: "update",
      sessionKey: "agent:research:shared-session",
    });

    expect(context.broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ hasActiveRun: false, activeRunIds: [] }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("projects active bare-global runs through the persisted fixed-store owner", async () => {
    const config = fixedStoreConfig();
    const context = createContext(
      new Set(["conn-1"]),
      config,
      new Map([
        [
          "ops-global-run",
          await createActiveRpcSourceForTest(
            {},
            {
              agentId: "ops",
              storeScope: resolveSessionStorePathCore(config.session?.store, { agentId: "ops" }),
              sessionId: "global-id",
              sessionKey: "global",
            },
          ),
        ],
      ]),
    );

    await emitAndSettleLeading(context, { reason: "update", sessionKey: "global" });

    expect(context.broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ activeRunIds: ["ops-global-run"], hasActiveRun: true }),
      expect.anything(),
      expect.objectContaining({ agentId: "ops", sessionKeys: ["global"] }),
    );
    const payload = broadcasts(context)[0]?.[1];
    expect(payload).not.toHaveProperty("agentId");
    expect(payload).not.toHaveProperty("goal");
  });

  it("keeps a retired fixed-store owner private after the mutation commits", async () => {
    const config = fixedStoreConfig(true);
    const context = createContext(new Set(["conn-1"]), config);

    await emitAndSettleLeading(context, { reason: "update", sessionKey: "global" });

    expect(mocks.loadRow).not.toHaveBeenCalled();
    expect(context.broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ sessionKey: "global", reason: "update" }),
      new Set(["conn-1"]),
      {
        agentId: "ops",
        dropIfSlow: true,
        sessionKeys: ["agent:ops:global"],
        sessionEventSubscriptionKeys: ["agent:ops:global"],
      },
    );
    const payload = broadcasts(context)[0]?.[1];
    for (const field of [
      "agentId",
      "key",
      "label",
      "session",
      "goal",
      "status",
      "hasActiveRun",
      "activeRunIds",
    ]) {
      expect(payload, field).not.toHaveProperty(field);
    }
  });

  it("tombstones exact run ids when lifecycle projection takes ownership", async () => {
    const sessionKey = "agent:main:projected";
    const sessionId = `${sessionKey}-id`;
    const context = createContext();
    const registration = registerRpcSourceForTest({
      runId: "direct-run",
      agentId: "main",
      storeScope: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      sessionId,
      sessionKey,
    });
    const release = await claimRpcSourceForTest(registration.entry);

    await emitAndSettleLeading(context, { reason: "update", sessionKey });
    expect(broadcasts(context)[0]?.[1]).toMatchObject({
      hasActiveRun: true,
      activeRunIds: ["direct-run"],
    });

    release();
    await registration.entry.input.settlement.promise;
    registerAgentRunContext("hidden-worker-run", {
      isControlUiVisible: false,
      projectSessionActive: true,
      sessionKey,
    });
    try {
      await emitAndSettleLeading(context, { reason: "update", sessionKey });
      await flushPendingSessionsChangedEvents(context);

      const payload = broadcasts(context)[1]?.[1];
      expect(payload).toMatchObject({ hasActiveRun: true });
      expect(payload).toHaveProperty("activeRunIds", null);
    } finally {
      clearAgentRunContext("hidden-worker-run");
    }
  });
});
