import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createSessionCapabilityHarness,
  sessionsResult,
} from "../../../ui/src/lib/sessions/session-capability.test-support.js";
import { resolveChatPaneDesktopTarget } from "../../../ui/src/pages/chat/chat-pane-placement.js";
import { createTestGatewayClient } from "../../../ui/src/test-helpers/gateway-client.js";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildProjectedAgentRunIndex,
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { createPluginRuntimeCapabilityLease } from "../../plugins/capability-lease.js";
import { createPluginServiceGatewayEvents } from "../../plugins/gateway-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { createGatewayConnectionState } from "../server-connection-state.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import {
  bindSessionRowProjection,
  getSessionRowProjection,
} from "../session-row-projection-access.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../session-row-projection.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import { loadCachedSessionSharingSnapshot } from "../session-sharing-snapshot-cache.js";
import { projectWorkerSessionPlacement } from "../worker-environments/placement-projector.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  loadRow: vi.fn(),
  rowLabel: "first",
}));

vi.mock("../session-sharing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-sharing.js")>();
  return {
    ...actual,
    invalidateSessionSharingSnapshot: mocks.invalidate.mockImplementation(
      actual.invalidateSessionSharingSnapshot,
    ),
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
  chatAbortControllers: GatewayRequestContext["chatAbortControllers"] = new Map(),
) {
  const projection = {
    get state() {
      return { rowContext: { projectedAgentRuns: buildProjectedAgentRunIndex() } };
    },
    capture: () => undefined,
    ensureMaterialized: async () => {},
    withPreparedExactRows: async (_queries: unknown, consume: () => unknown) => ({
      kind: "complete",
      value: consume(),
    }),
    snapshot: ({ key }: { key: string }) => ({ row: mocks.loadRow(key) }),
  };
  return {
    broadcastToConnIds: vi.fn(),
    chatAbortControllers,
    getRuntimeConfig: () => config,
    ...bindSessionRowProjection({}, () => projection as unknown as SessionRowProjection),
    getSessionEventSubscriberConnIds: () => receivers,
    mentionInbox: { invalidate: vi.fn() },
  } as unknown as GatewayRequestContext;
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
  const snapshot = vi.spyOn(projection, "snapshot");
  const update = () => {
    const record = projection.describe({ key: sessionKey, agentId: "main" });
    if (!record) {
      throw new Error("missing resident placement row");
    }
    const placement = placements.get(record.entry.sessionId);
    // Simulate committed owner facts without reading the placement store during event snapshots.
    if (placement) {
      record.materialized.row.placement = projectWorkerSessionPlacement(placement);
    } else {
      delete record.materialized.row.placement;
    }
  };
  update();
  return { update, snapshot };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.invalidate();
  mocks.invalidate.mockClear();
  mocks.loadRow.mockReset().mockImplementation((key: string) => ({
    key,
    label: mocks.rowLabel,
    sessionId: `${key}-id`,
  }));
  mocks.rowLabel = "first";
});

afterEach(async () => {
  await flushPendingSessionsChangedEvents();
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
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(context.mentionInbox?.invalidate).not.toHaveBeenCalled();
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
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(context.mentionInbox?.invalidate).toHaveBeenCalledOnce();
    expect(readGatewayAccessRevision()).toBe(initialAccessRevision + 1);
  });

  it("publishes the latest placement through coalesced unrelated mutations and clears it explicitly", async () => {
    const context = createContext();
    const sessionKey = "agent:main:cloud";
    const first = activePlacement(sessionKey);
    const placements = new Map<string, WorkerSessionPlacementRecord>([[first.sessionId, first]]);
    const getMany = vi.fn(() => placements);
    context.workerSessionPlacementService = { getMany };
    const resident = preparePlacementProjection(context, sessionKey, placements);

    resident.update();
    await emitAndSettleLeading(context, { reason: "placement", sessionKey });
    expect(vi.mocked(context.broadcastToConnIds).mock.calls[0]?.[1]).toMatchObject({
      placement: { state: "active", generation: 1, environmentId: "worker-first" },
      placementMove: null,
    });
    placements.set(first.sessionId, {
      ...first,
      state: "draining",
      generation: 2,
      turnClaim: null,
    });
    resident.update();
    await emitAndSettleLeading(context, { reason: "placement", sessionKey });
    placements.set(first.sessionId, {
      ...first,
      generation: 3,
      environmentId: "worker-replacement",
    });
    resident.update();
    await emitAndSettleLeading(context, { reason: "mark-read", sessionKey });
    await vi.advanceTimersByTimeAsync(100);

    const published = vi.mocked(context.broadcastToConnIds).mock.calls.at(-1)?.[1];
    expect(published).toMatchObject({
      reason: "mark-read",
      placement: { state: "active", generation: 3, environmentId: "worker-replacement" },
    });
    expect(published).not.toHaveProperty("placement.turnClaim");
    expect(JSON.stringify(published)).not.toContain("private-turn-claim");
    expect(getMany).not.toHaveBeenCalled();
    expect(resident.snapshot).toHaveBeenCalledTimes(2);
    expect(resident.snapshot).toHaveBeenLastCalledWith({ key: sessionKey, agentId: "main" });

    placements.clear();
    resident.update();
    await emitAndSettleLeading(context, { reason: "placement", sessionKey });
    expect(vi.mocked(context.broadcastToConnIds).mock.calls.at(-1)?.[1]).toMatchObject({
      placement: null,
      placementMove: null,
    });
    delete context.workerSessionPlacementService;
    resident.update();
    await emitAndSettleLeading(context, { reason: "patch", sessionKey });
    await vi.advanceTimersByTimeAsync(100);
    const withoutReader = vi.mocked(context.broadcastToConnIds).mock.calls.at(-1)?.[1];
    expect(withoutReader).not.toHaveProperty("placement");
    expect(withoutReader).not.toHaveProperty("placementMove");
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
    vi.mocked(context.broadcastToConnIds).mockImplementation((event, payload) => {
      const frame = JSON.stringify({ type: "event", event, payload });
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
      await vi.advanceTimersByTimeAsync(200);
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
    } finally {
      sessions.dispose();
    }
  });

  it.each(["blocked", "failed"] as const)(
    "publishes an exact row while unrelated bulk preparation is %s",
    async (state) => {
      const context = createContext();
      const projection = getSessionRowProjection(context)!;
      const unrelated = createDeferred();
      const bulk = vi.spyOn(projection, "ensureMaterialized");
      if (state === "blocked") {
        bulk.mockReturnValue(unrelated.promise);
      } else {
        bulk.mockRejectedValue(new Error("unrelated bulk row failed"));
      }
      const bulkWork = projection.ensureMaterialized().catch(() => undefined);
      const sessionKey = "agent:main:ready";
      try {
        await emitAndSettleLeading(context, { reason: "patch", sessionKey });
        expect(context.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
          "sessions.changed",
          expect.objectContaining({
            session: expect.objectContaining({
              key: sessionKey,
              sessionId: `${sessionKey}-id`,
              label: "first",
            }),
          }),
          new Set(["conn-1"]),
          expect.objectContaining({ sessionKeys: [sessionKey] }),
        );
        expect(bulk).toHaveBeenCalledOnce();
      } finally {
        unrelated.resolve();
        await bulkWork;
        await flushPendingSessionsChangedEvents(context);
      }
    },
  );

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
    expect(
      vi.mocked(context.broadcastToConnIds).mock.calls.map(([, payload]) => payload),
    ).toMatchObject([
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
    const earlyPublications = vi.mocked(context.broadcastToConnIds).mock.calls.length;
    prepared.resolve();
    await flushPendingSessionsChangedEvents(context);
    expect(earlyPublications).toBe(0);
    expect(
      vi.mocked(context.broadcastToConnIds).mock.calls.map(([, payload]) => payload),
    ).toMatchObject([
      { reason: "patch", sessionId: "removed" },
      { reason: "delete", sessionId: "removed" },
    ]);
  });

  it("preserves a trailing tombstone before a replacement generation", async () => {
    const context = createContext();
    const sessionKey = "agent:main:chat";
    await emitAndSettleLeading(context, { reason: "patch", sessionKey, sessionId: "removed" });
    emitSessionsChanged(context, { reason: "delete", sessionKey, sessionId: "removed" });
    emitSessionsChanged(context, { reason: "create", sessionKey, sessionId: "replacement" });
    mocks.loadRow.mockReturnValue({ key: sessionKey, sessionId: "replacement" });
    await flushPendingSessionsChangedEvents(context);
    const payloads = vi.mocked(context.broadcastToConnIds).mock.calls.map(([, payload]) => payload);
    expect(payloads).toMatchObject([
      { reason: "patch", sessionId: "removed" },
      { reason: "delete", sessionId: "removed" },
      { reason: "create", sessionId: "replacement", session: { sessionId: "replacement" } },
    ]);
    expect(payloads[1]).not.toHaveProperty("session");
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

  it.each([true, false])(
    "bounds held generation churn for roster and plugins (tombstones: %s)",
    async (tombstones) => {
      const context = createContext();
      const sessionKey = "agent:main:churn";
      const first = {
        key: sessionKey,
        sessionId: "generation-0",
        kind: "direct" as const,
        updatedAt: 1,
      };
      const latest = { ...first, sessionId: "generation-128", label: "latest", updatedAt: 2 };
      let response = sessionsResult([first], 1);
      const request = vi.fn(async () => response);
      const client = createTestGatewayClient(request);
      const { sessions, emitEvent } = createSessionCapabilityHarness(client.request.bind(client));
      const broadcaster = createGatewayBroadcaster({ clients: new GatewayClientRegistry() });
      const lease = createPluginRuntimeCapabilityLease("bounded-events");
      const pluginEvents = createPluginServiceGatewayEvents({
        pluginId: "bounded-events",
        broadcast: vi.fn(),
        lease,
      });
      const notices = vi.fn();
      pluginEvents!.onSessionsChanged(notices);
      vi.mocked(context.broadcastToConnIds).mockImplementation(
        (event, payload, connIds, options) => {
          broadcaster.broadcastToConnIds(event, payload, connIds, options);
          emitEvent({ type: "event", event, payload });
        },
      );
      const prepared = createDeferred();
      const exactPreparation = holdExactPreparation(
        getSessionRowProjection(context)!,
        prepared.promise,
      );
      try {
        await sessions.refresh({ agentId: "main", force: true });
        const initialReads = request.mock.calls.length;
        emitSessionsChanged(context, { reason: "patch", sessionKey, sessionId: first.sessionId });
        await Promise.resolve();
        for (let generation = 0; generation < 128; generation += 1) {
          if (tombstones) {
            emitSessionsChanged(context, {
              reason: "delete",
              sessionKey,
              sessionId: `generation-${generation}`,
            });
          }
          emitSessionsChanged(context, {
            reason: "create",
            sessionKey,
            sessionId: `generation-${generation + 1}`,
          });
        }
        expect(context.broadcastToConnIds).not.toHaveBeenCalled();
        response = sessionsResult([latest], 2);
        mocks.loadRow.mockReturnValue(latest);
        prepared.resolve();
        await flushPendingSessionsChangedEvents(context);
        await vi.advanceTimersByTimeAsync(200);
        expect(
          vi.mocked(context.broadcastToConnIds).mock.calls.map(([, payload]) => payload),
        ).toMatchObject([
          { reason: "patch", sessionId: "generation-0" },
          ...(tombstones ? [{ reason: "delete", sessionId: "generation-0" }] : []),
          { reason: "create", sessionId: "generation-128" },
          { reason: "update" },
        ]);
        expect(vi.mocked(context.broadcastToConnIds).mock.calls.at(-1)?.[1]).not.toHaveProperty(
          "sessionKey",
        );
        expect(exactPreparation).toHaveBeenCalledTimes(2);
        expect(notices).toHaveBeenCalledTimes(tombstones ? 3 : 2);
        expect(notices).toHaveBeenLastCalledWith(
          expect.objectContaining({ sessionKey, reason: "create", label: "latest" }),
        );
        expect(request).toHaveBeenCalledTimes(initialReads + 1);
        expect(sessions.state.result?.sessions).toEqual([latest]);
      } finally {
        prepared.resolve();
        await flushPendingSessionsChangedEvents(context);
        sessions.dispose();
        lease.revoke();
      }
    },
  );

  it("keeps persisted replacement identity through recipient projection", async () => {
    vi.useRealTimers();
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = { agents: { entries: { main: {} } } };
      const sessionKey = "agent:main:replacement";
      const target = { agentId: "main", sessionKey };
      replaceSessionEntrySync(target, {
        sessionId: "original",
        updatedAt: 1,
        visibility: "shared",
      });
      const projection = await createSessionRowProjection({ cfg: config });
      const context = createContext(new Set(["conn-1"]), config);
      bindSessionRowProjection(context, () => projection);
      const connection = createGatewayConnectionState({ bootId: "event-generation", cfg: config });
      const send = vi.fn<(frame: string) => void>();
      connection.clients.add({
        connId: "conn-1",
        usesSharedGatewayAuth: false,
        connect: {
          minProtocol: 4,
          maxProtocol: 4,
          client: { id: "test", mode: "test", version: "1", platform: "test" },
          role: "operator",
          scopes: ["operator.admin"],
        },
        socket: {
          readyState: 1,
          bufferedAmount: 0,
          send,
          close: vi.fn(),
          terminate: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          once: vi.fn(),
        },
      });
      const detach = connection.attachSessionRowProjection(projection);
      context.broadcastToConnIds = vi.fn(connection.broadcastToConnIds);
      const prepared = createDeferred();
      try {
        await projection.ensureMaterialized();
        // A cold resident row may have no capture; the committed producer ID still fences it.
        vi.spyOn(projection, "capture").mockReturnValueOnce(undefined);
        const preparation = holdExactPreparation(projection, prepared.promise);
        emitSessionsChanged(context, { reason: "patch", sessionKey, sessionId: "original" });
        await Promise.resolve();
        replaceSessionEntrySync(target, {
          sessionId: "replacement",
          updatedAt: 2,
          visibility: "shared",
        });
        emitSessionsChanged(context, { reason: "delete", sessionKey, sessionId: "original" });
        emitSessionsChanged(context, { reason: "create", sessionKey, sessionId: "replacement" });
        prepared.resolve();
        await flushPendingSessionsChangedEvents(context);
        const payloads = vi
          .mocked(context.broadcastToConnIds)
          .mock.calls.map(([, payload]) => payload);
        expect(payloads).toMatchObject([
          { reason: "patch", sessionKey },
          { reason: "delete", sessionId: "original" },
          { reason: "create", session: { sessionId: "replacement" } },
        ]);
        expect(payloads[0]).not.toHaveProperty("session");
        expect(payloads[1]).not.toHaveProperty("session");
        expect(send.mock.calls.map(([frame]) => JSON.parse(frame).payload)).toMatchObject([
          { reason: "delete", sessionId: "original" },
          { reason: "create", sessionId: "replacement", session: { sessionId: "replacement" } },
        ]);
        preparation.mockRestore();

        for (const failedCapture of [false, true]) {
          send.mockClear();
          const held = createDeferred();
          const heldPreparation = holdExactPreparation(projection, held.promise);
          const sessionId = failedCapture ? "recaptured-after-failure" : "recaptured-replacement";
          try {
            emitSessionsChanged(context, { reason: "patch", sessionKey });
            await Promise.resolve();
            if (failedCapture) {
              vi.spyOn(projection, "capture").mockImplementationOnce(() => {
                throw new Error("synthetic pending capture failure");
              });
            }
            emitSessionsChanged(context, { reason: "send", sessionKey });
            replaceSessionEntrySync(target, {
              sessionId,
              updatedAt: Date.now(),
              visibility: "shared",
            });
            // Settled notices omit sessionId and coalesce with the queued generation.
            emitSessionsChanged(context, { reason: "agent.input.settled", sessionKey });
            held.resolve();
            await flushPendingSessionsChangedEvents(context);
            expect(
              send.mock.calls
                .map(([frame]) => JSON.parse(frame).payload)
                .filter((payload) => payload.sessionKey === sessionKey),
            ).toMatchObject([
              {
                reason: "agent.input.settled",
                sessionKey,
                sessionId,
                session: { sessionId },
              },
            ]);
          } finally {
            held.resolve();
            await flushPendingSessionsChangedEvents(context);
            heldPreparation.mockRestore();
          }
        }
      } finally {
        prepared.resolve();
        await flushPendingSessionsChangedEvents(context);
        detach();
        connection.mentionInbox.dispose();
        projection.dispose();
      }
    });
  });

  it.each([
    "agent.input.settled",
    "agent.run.started",
    "send",
    "steer",
    "abort",
    "chat.title",
    "chat.dispatch-error",
    "goal",
    "compact",
    "cron-continue",
  ])("carries a complete session row for %s without a roster refetch", async (reason) => {
    const context = createContext();
    await emitAndSettleLeading(context, { reason, sessionKey: "agent:main:chat" });
    expect(vi.mocked(context.broadcastToConnIds).mock.calls[0]?.[1]).toMatchObject({
      reason,
      session: { key: "agent:main:chat", sessionId: "agent:main:chat-id", label: "first" },
    });
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
    expect(vi.mocked(context.broadcastToConnIds).mock.calls[1]?.[1]).toMatchObject({
      label: "latest",
      reason: "send",
      catalogChanged: true,
    });
    expect(readGatewayAccessRevision()).toBe(initialAccessRevision + 3);
    expect(mocks.invalidate).toHaveBeenCalledTimes(3);
    await emitAndSettleLeading(context, { reason: "patch", sessionKey: "agent:main:chat" });
    expect(vi.mocked(context.broadcastToConnIds).mock.calls.at(-1)?.[1]).not.toHaveProperty(
      "catalogChanged",
    );
  });

  it.each([true, false])(
    "refreshes metadata projections without expiring access (receivers: %s)",
    async (receivesEvents) => {
      const context = createContext(new Set(receivesEvents ? ["conn-1"] : []));
      const sessionKey = "agent:main:metadata";
      const initialAccessRevision = readGatewayAccessRevision();
      const resolve = vi.fn(() => ({
        canonicalKey: sessionKey,
        snapshot: { incognito: false, visibility: "shared" as const },
      }));
      loadCachedSessionSharingSnapshot({ sessionKey, resolve });

      await emitAndSettleLeading(
        context,
        { reason: "patch", sessionKey },
        { accessChanged: false },
      );

      expect(readGatewayAccessRevision()).toBe(initialAccessRevision);
      expect(context.mentionInbox?.invalidate).toHaveBeenCalledOnce();
      loadCachedSessionSharingSnapshot({ sessionKey, resolve });
      expect(resolve).toHaveBeenCalledTimes(2);
      if (receivesEvents) {
        const payload = vi.mocked(context.broadcastToConnIds).mock.calls[0]?.[1];
        expect(payload).toMatchObject({ reason: "patch", sessionKey, label: "first" });
        expect(payload).not.toHaveProperty("accessChanged");
      } else {
        expect(context.broadcastToConnIds).not.toHaveBeenCalled();
        expect(mocks.loadRow).not.toHaveBeenCalled();
      }
    },
  );

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
    expect(vi.mocked(context.broadcastToConnIds).mock.calls[1]?.[1]).toMatchObject({
      label: "state-5",
      reason: "update-5",
    });
  });

  it.each([false, true])(
    "never samples a replacement for a delete (trailing: %s)",
    async (trailing) => {
      const context = createContext();
      const sessionKey = "agent:main:chat";
      if (trailing) {
        await emitAndSettleLeading(context, { reason: "update", sessionKey });
      }
      mocks.loadRow.mockClear();
      const deletion = { reason: "delete", sessionKey, sessionId: "generation-a", agentId: "main" };
      await emitAndSettleLeading(context, deletion);
      mocks.rowLabel = "replacement-b";
      await vi.advanceTimersByTimeAsync(100);
      const payload = vi.mocked(context.broadcastToConnIds).mock.calls.at(-1)?.[1];
      expect(payload).toEqual({
        ...deletion,
        agentId: "main",
        ts: expect.any(Number),
      });
      expect(mocks.loadRow).not.toHaveBeenCalled();
    },
  );

  it("keeps different session keys independent", async () => {
    const context = createContext();

    await emitAndSettleLeading(context, { reason: "update", sessionKey: "agent:main:first" });
    await emitAndSettleLeading(context, { reason: "update", sessionKey: "agent:main:second" });

    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(2);
    expect(mocks.loadRow).toHaveBeenCalledTimes(2);
  });

  it("does not adopt the compatibility owner's ownerless run for another agent", async () => {
    const config = retainLegacyDefaultAgentId(
      {
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      },
      "ops",
    );
    const sessionId = "agent:research:shared-session-id";
    const context = createContext(
      new Set(["conn-1"]),
      config,
      new Map([
        [
          "compat-owner-run",
          {
            controller: new AbortController(),
            expiresAtMs: 60_000,
            sessionId,
            sessionKey: "legacy-unscoped",
            startedAtMs: 0,
          } satisfies ChatAbortControllerEntry,
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
    const config = {
      session: { scope: "global", store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;
    const context = createContext(
      new Set(["conn-1"]),
      config,
      new Map([
        [
          "ops-global-run",
          {
            agentId: "ops",
            controller: new AbortController(),
            expiresAtMs: 60_000,
            sessionId: "global-id",
            sessionKey: "global",
            startedAtMs: 0,
          } satisfies ChatAbortControllerEntry,
        ],
      ]),
    );

    await emitAndSettleLeading(context, { reason: "update", sessionKey: "global" });

    expect(context.broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        activeRunIds: ["ops-global-run"],
        hasActiveRun: true,
      }),
      expect.anything(),
      expect.objectContaining({
        agentId: "ops",
        sessionKeys: ["global"],
      }),
    );
    const payload = vi.mocked(context.broadcastToConnIds).mock.calls[0]?.[1];
    expect(payload).not.toHaveProperty("agentId");
    expect(payload).not.toHaveProperty("goal");
  });

  it("keeps a retired fixed-store owner private after the mutation commits", async () => {
    const config = {
      session: { scope: "global", store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { research: {} },
      },
    } satisfies OpenClawConfig;
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
      },
    );
    const payload = vi.mocked(context.broadcastToConnIds).mock.calls[0]?.[1];
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
    const chatAbortControllers = new Map([
      [
        "direct-run",
        {
          agentId: "main",
          controller: new AbortController(),
          expiresAtMs: 60_000,
          sessionId,
          sessionKey,
          startedAtMs: 0,
        } satisfies ChatAbortControllerEntry,
      ],
    ]);
    const context = createContext(new Set(["conn-1"]), {}, chatAbortControllers);

    await emitAndSettleLeading(context, { reason: "update", sessionKey });
    expect(vi.mocked(context.broadcastToConnIds).mock.calls[0]?.[1]).toMatchObject({
      hasActiveRun: true,
      activeRunIds: ["direct-run"],
    });

    chatAbortControllers.clear();
    registerAgentRunContext("hidden-worker-run", {
      isControlUiVisible: false,
      projectSessionActive: true,
      sessionKey,
    });
    try {
      await emitAndSettleLeading(context, { reason: "update", sessionKey });
      await flushPendingSessionsChangedEvents(context);

      const payload = vi.mocked(context.broadcastToConnIds).mock.calls[1]?.[1];
      expect(payload).toMatchObject({ hasActiveRun: true });
      expect(payload).toHaveProperty("activeRunIds", null);
    } finally {
      clearAgentRunContext("hidden-worker-run");
    }
  });

  it("invalidates sharing without loading rows when nobody receives events", async () => {
    const context = createContext(new Set());

    await emitAndSettleLeading(context, { reason: "update", sessionKey: "agent:main:chat" });

    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(context.mentionInbox?.invalidate).toHaveBeenCalledOnce();
    expect(mocks.invalidate.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(context.mentionInbox!.invalidate).mock.invocationCallOrder[0]!,
    );
    expect(mocks.loadRow).not.toHaveBeenCalled();
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("flushes the latest trailing row and clears its shutdown timer", async () => {
    const context = createContext();
    await emitAndSettleLeading(context, { reason: "create", sessionKey: "agent:main:chat" });
    mocks.rowLabel = "shutdown-latest";
    await emitAndSettleLeading(context, { reason: "send", sessionKey: "agent:main:chat" });

    await flushPendingSessionsChangedEvents(context);
    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(2);
    expect(vi.mocked(context.broadcastToConnIds).mock.calls[1]?.[1]).toMatchObject({
      label: "shutdown-latest",
      reason: "send",
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(2);
  });
});
