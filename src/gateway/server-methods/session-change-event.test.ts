import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createSessionCapabilityHarness,
  sessionsResult,
} from "../../../ui/src/lib/sessions/session-capability.test-support.js";
import { resolveChatPaneDesktopTarget } from "../../../ui/src/pages/chat/chat-pane-placement.js";
import { createTestGatewayClient } from "../../../ui/src/test-helpers/gateway-client.js";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import { createGatewaySidecarStopOwner } from "../server-sidecar-owners.js";
import { loadCachedSessionSharingSnapshot } from "../session-sharing-snapshot-cache.js";
import type { WorkerSessionPlacementProjection } from "../worker-environments/placement-read-projection.js";
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

vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...actual,
    loadGatewaySessionRow: mocks.loadRow.mockImplementation((key: string) => ({
      key,
      label: mocks.rowLabel,
      sessionId: `${key}-id`,
    })),
  };
});

vi.mock("../session-event-payload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-event-payload.js")>();
  return {
    ...actual,
    buildGatewaySessionEventFields: ({
      sessionRow,
      hasActiveRun,
      activeRunIds,
    }: {
      sessionRow: { key: string; label: string };
      hasActiveRun?: boolean;
      activeRunIds?: string[] | null;
    }) => ({
      key: sessionRow.key,
      label: sessionRow.label,
      ...(hasActiveRun === undefined ? {} : { hasActiveRun }),
      ...(activeRunIds === undefined ? {} : { activeRunIds }),
    }),
  };
});

const {
  emitSessionsChanged,
  flushPendingSessionsChangedEvents,
  readSessionsMutationVersion,
  attachSessionChangeEventLifetime,
} = await import("./session-change-event.js");

function createContext(
  receivers = new Set(["conn-1"]),
  config: OpenClawConfig = {},
  chatAbortControllers: GatewayRequestContext["chatAbortControllers"] = new Map(),
) {
  return {
    broadcastToConnIds: vi.fn(),
    chatAbortControllers,
    getRuntimeConfig: () => config,
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

function placementSnapshot(
  placements: ReadonlyMap<string, WorkerSessionPlacementRecord>,
): WorkerSessionPlacementProjection {
  return {
    placements: new Map(placements),
    moves: new Map(),
    workspaceResultReconcilingSessionIds: new Set(),
    environments: new Map(),
  };
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
  it("publishes the latest placement through coalesced unrelated mutations and clears it explicitly", async () => {
    const context = createContext();
    const sessionKey = "agent:main:cloud";
    const first = activePlacement(sessionKey);
    const placements = new Map<string, WorkerSessionPlacementRecord>([[first.sessionId, first]]);
    const readProjection = vi.fn(async () => placementSnapshot(placements));
    context.workerSessionPlacementService = { getMany: () => placements, readProjection };

    emitSessionsChanged(context, { reason: "placement", sessionKey });
    await vi.advanceTimersByTimeAsync(0);
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
    emitSessionsChanged(context, { reason: "placement", sessionKey });
    await vi.advanceTimersByTimeAsync(0);
    placements.set(first.sessionId, {
      ...first,
      generation: 3,
      environmentId: "worker-replacement",
    });
    emitSessionsChanged(context, { reason: "mark-read", sessionKey });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);

    const published = vi.mocked(context.broadcastToConnIds).mock.calls.at(-1)?.[1];
    expect(published).toMatchObject({
      reason: "mark-read",
      placement: { state: "active", generation: 3, environmentId: "worker-replacement" },
    });
    expect(published).not.toHaveProperty("placement.turnClaim");
    expect(JSON.stringify(published)).not.toContain("private-turn-claim");
    expect(readProjection).toHaveBeenCalledTimes(2);
    expect(readProjection).toHaveBeenLastCalledWith([first.sessionId]);

    placements.clear();
    emitSessionsChanged(context, { reason: "placement", sessionKey });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(context.broadcastToConnIds).mock.calls.at(-1)?.[1]).toMatchObject({
      placement: null,
      placementMove: null,
    });
    delete context.workerSessionPlacementService;
    emitSessionsChanged(context, { reason: "patch", sessionKey });
    await vi.advanceTimersByTimeAsync(0);
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
    context.workerSessionPlacementService = {
      getMany: () => placements,
      readProjection: async () => placementSnapshot(placements),
    };
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
      emitEvent({ type: "event", event, payload });
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

      emitSessionsChanged(context, { reason: "placement", sessionKey });
      await vi.advanceTimersByTimeAsync(0);
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
      emitSessionsChanged(context, { reason: "placement", sessionKey });
      await vi.advanceTimersByTimeAsync(0);
      await flushPendingSessionsChangedEvents(context);
      expect(resolveChatPaneDesktopTarget(row())).toBeNull();
      placements.set(first.sessionId, {
        ...first,
        generation: 3,
        environmentId: "worker-replacement",
      });
      emitSessionsChanged(context, { reason: "placement", sessionKey });
      await vi.advanceTimersByTimeAsync(0);
      expect(resolveChatPaneDesktopTarget(row())).toBe("worker-replacement");
      stale.resolve(initial);
      await oldRefresh;
      expect(resolveChatPaneDesktopTarget(row())).toBe("worker-replacement");

      placements.clear();
      emitSessionsChanged(context, { reason: "placement", sessionKey });
      await vi.advanceTimersByTimeAsync(0);
      await flushPendingSessionsChangedEvents(context);
      expect(row()).not.toHaveProperty("placement");
      expect(row()).not.toHaveProperty("placementMove");
    } finally {
      sessions.dispose();
    }
  });

  it("emits a leading row and one trailing row with the latest state", async () => {
    const context = createContext();
    const initialVersion = readSessionsMutationVersion(context);
    const initialAccessRevision = readGatewayAccessRevision();

    emitSessionsChanged(context, { reason: "create", sessionKey: "agent:main:chat" });
    await vi.advanceTimersByTimeAsync(0);
    mocks.rowLabel = "latest";
    emitSessionsChanged(context, { reason: "update", sessionKey: "agent:main:chat" });
    await vi.advanceTimersByTimeAsync(0);
    emitSessionsChanged(context, { reason: "send", sessionKey: "agent:main:chat" });
    await vi.advanceTimersByTimeAsync(0);

    expect(context.broadcastToConnIds).toHaveBeenCalledOnce();
    expect(mocks.loadRow).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);

    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(2);
    expect(mocks.loadRow).toHaveBeenCalledTimes(2);
    expect(vi.mocked(context.broadcastToConnIds).mock.calls[1]?.[1]).toMatchObject({
      label: "latest",
      reason: "send",
    });
    expect(readSessionsMutationVersion(context)).toBe(initialVersion + 3);
    expect(readGatewayAccessRevision()).toBe(initialAccessRevision + 3);
    expect(mocks.invalidate).toHaveBeenCalledTimes(3);
  });

  it.each([true, false])(
    "refreshes metadata projections without expiring access (receivers: %s)",
    async (receivesEvents) => {
      const context = createContext(new Set(receivesEvents ? ["conn-1"] : []));
      const sessionKey = "agent:main:metadata";
      const initialVersion = readSessionsMutationVersion(context);
      const initialAccessRevision = readGatewayAccessRevision();
      const resolve = vi.fn(() => ({
        canonicalKey: sessionKey,
        snapshot: { incognito: false, visibility: "shared" as const },
      }));
      loadCachedSessionSharingSnapshot({ sessionKey, resolve });

      emitSessionsChanged(context, { reason: "patch", sessionKey }, { accessChanged: false });

      expect(readGatewayAccessRevision()).toBe(initialAccessRevision);
      expect(readSessionsMutationVersion(context)).toBe(initialVersion + 1);
      expect(context.mentionInbox?.invalidate).toHaveBeenCalledOnce();
      loadCachedSessionSharingSnapshot({ sessionKey, resolve });
      expect(resolve).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(0);
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

    emitSessionsChanged(context, { reason: "leading", sessionKey });
    await vi.advanceTimersByTimeAsync(0);
    emitSessionsChanged(context, { reason: "update-0", sessionKey });
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 1; index <= 5; index += 1) {
      await vi.advanceTimersByTimeAsync(90);
      mocks.rowLabel = `state-${index}`;
      emitSessionsChanged(context, { reason: `update-${index}`, sessionKey });
      await vi.advanceTimersByTimeAsync(0);
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
        emitSessionsChanged(context, { reason: "update", sessionKey });
        await vi.advanceTimersByTimeAsync(0);
      }
      mocks.loadRow.mockClear();
      const deletion = { reason: "delete", sessionKey, sessionId: "generation-a", agentId: "main" };
      emitSessionsChanged(context, deletion);
      await vi.advanceTimersByTimeAsync(0);
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

    emitSessionsChanged(context, { reason: "update", sessionKey: "agent:main:first" });
    await vi.advanceTimersByTimeAsync(0);
    emitSessionsChanged(context, { reason: "update", sessionKey: "agent:main:second" });
    await vi.advanceTimersByTimeAsync(0);

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

    emitSessionsChanged(context, {
      reason: "update",
      sessionKey: "agent:research:shared-session",
    });
    await vi.advanceTimersByTimeAsync(0);

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

    emitSessionsChanged(context, { reason: "update", sessionKey: "global" });
    await vi.advanceTimersByTimeAsync(0);

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

    emitSessionsChanged(context, { reason: "update", sessionKey: "global" });
    await vi.advanceTimersByTimeAsync(0);

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

    emitSessionsChanged(context, { reason: "update", sessionKey });
    await vi.advanceTimersByTimeAsync(0);
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
      emitSessionsChanged(context, { reason: "update", sessionKey });
      await vi.advanceTimersByTimeAsync(0);
      await flushPendingSessionsChangedEvents(context);

      const payload = vi.mocked(context.broadcastToConnIds).mock.calls[1]?.[1];
      expect(payload).toMatchObject({ hasActiveRun: true });
      expect(payload).toHaveProperty("activeRunIds", null);
    } finally {
      clearAgentRunContext("hidden-worker-run");
    }
  });

  it("advances the mutation fence without loading rows when nobody receives events", async () => {
    const context = createContext(new Set());
    const initialVersion = readSessionsMutationVersion(context);

    emitSessionsChanged(context, { reason: "update", sessionKey: "agent:main:chat" });

    expect(readSessionsMutationVersion(context)).toBe(initialVersion + 1);
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
    emitSessionsChanged(context, { reason: "create", sessionKey: "agent:main:chat" });
    await vi.advanceTimersByTimeAsync(0);
    mocks.rowLabel = "shutdown-latest";
    emitSessionsChanged(context, { reason: "send", sessionKey: "agent:main:chat" });
    await vi.advanceTimersByTimeAsync(0);

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

describe("sessions.changed preparation lifetime", () => {
  it("invalidates synchronously and joins ordered leading/trailing preparation", async () => {
    const context = createContext();
    const sessionKey = "agent:main:owned";
    const first = activePlacement(sessionKey);
    const placements = new Map<string, WorkerSessionPlacementRecord>([[first.sessionId, first]]);
    let entered = false;
    const release = createDeferred();
    let reads = 0;
    context.workerSessionPlacementService = {
      getMany: vi.fn(() => {
        throw new Error("synchronous placement reads are not event preparation");
      }),
      readProjection: async () => {
        const snapshot = placementSnapshot(placements);
        if (++reads === 1) {
          entered = true;
          await release.promise;
        }
        return snapshot;
      },
    };
    const sidecars = createGatewaySidecarStopOwner();
    attachSessionChangeEventLifetime(context, () =>
      sidecars.publish({ stop: () => flushPendingSessionsChangedEvents(context) }),
    );
    try {
      const version = readSessionsMutationVersion(context);
      emitSessionsChanged(context, { reason: "placement", sessionKey });
      expect(readSessionsMutationVersion(context)).toBe(version + 1);
      expect(mocks.loadRow).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      expect(entered).toBe(true);
      placements.set(first.sessionId, { ...first, generation: 2 });
      emitSessionsChanged(context, { reason: "mark-read", sessionKey });
      const stopped = vi.fn();
      const closing = sidecars.stop().then(stopped);
      await vi.advanceTimersByTimeAsync(100);
      expect(stopped).not.toHaveBeenCalled();
      expect(context.broadcastToConnIds).not.toHaveBeenCalled();
      release.resolve();
      await closing;
      await sidecars.sealAndJoin();
      const payloads = vi.mocked(context.broadcastToConnIds).mock.calls.map((call) => call[1]);
      expect(payloads).toHaveLength(2);
      expect(payloads[0]).toMatchObject({ reason: "placement", sessionKey });
      expect(payloads[0]).not.toHaveProperty("placement");
      expect(payloads[1]).toMatchObject({ reason: "mark-read", placement: { generation: 2 } });
      expect(reads).toBe(2);
      expect(sidecars.snapshot()).toEqual([]);
      emitSessionsChanged(context, { reason: "after-seal", sessionKey });
      await vi.advanceTimersByTimeAsync(100);
      expect(reads).toBe(2);
      expect(context.broadcastToConnIds).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await sidecars.stop();
      await flushPendingSessionsChangedEvents(context);
      await sidecars.sealAndJoin();
    }
  });

  it("joins a new key admitted by another sidecar while shutdown is closing", async () => {
    const context = createContext();
    const sidecars = createGatewaySidecarStopOwner();
    attachSessionChangeEventLifetime(context, () =>
      sidecars.publish({ stop: () => flushPendingSessionsChangedEvents(context) }),
    );
    let entered = false;
    const release = createDeferred();
    context.workerSessionPlacementService = {
      getMany: () => new Map(),
      readProjection: async () => {
        entered = true;
        await release.promise;
        return placementSnapshot(new Map());
      },
    };
    sidecars.publish({
      stop: async () => {
        await Promise.resolve();
        emitSessionsChanged(context, { reason: "late-cleanup", sessionKey: "agent:main:late" });
      },
    });
    try {
      const stopped = vi.fn();
      const closing = sidecars.stop().then(stopped);
      await vi.advanceTimersByTimeAsync(0);
      expect(entered).toBe(true);
      expect(stopped).not.toHaveBeenCalled();
      release.resolve();
      await closing;
      await sidecars.sealAndJoin();
      expect(context.broadcastToConnIds).toHaveBeenCalledOnce();
      expect(vi.mocked(context.broadcastToConnIds).mock.calls[0]?.[1]).toMatchObject({
        reason: "late-cleanup",
      });
      expect(sidecars.snapshot()).toEqual([]);
    } finally {
      release.resolve();
      await sidecars.stop();
      await flushPendingSessionsChangedEvents(context);
      await sidecars.sealAndJoin();
    }
  });

  it.each(["row replacement", "mutation without receivers"])(
    "rereads recipients and invalidates prepared placement after %s",
    async (change) => {
      let recipients = new Set(["old-connection"]);
      const context = { ...createContext(), getSessionEventSubscriberConnIds: () => recipients };
      const sessionKey = "agent:main:replaced";
      const placement = activePlacement(sessionKey);
      let entered = false;
      const release = createDeferred();
      context.workerSessionPlacementService = {
        getMany: () => new Map(),
        readProjection: async () => {
          entered = true;
          await release.promise;
          return placementSnapshot(new Map([[placement.sessionId, placement]]));
        },
      };
      try {
        emitSessionsChanged(context, { reason: "placement", sessionKey });
        await vi.advanceTimersByTimeAsync(0);
        expect(entered).toBe(true);
        if (change === "row replacement") {
          mocks.loadRow.mockReturnValueOnce({
            key: sessionKey,
            sessionId: "replacement",
            label: "new row",
          });
        } else {
          recipients = new Set();
          emitSessionsChanged(context, { reason: "placement", sessionKey });
        }
        recipients = new Set(["new-connection"]);
        const flushed = flushPendingSessionsChangedEvents(context);
        release.resolve();
        await flushed;
        expect(context.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
          "sessions.changed",
          expect.objectContaining({ sessionKey, reason: "placement" }),
          new Set(["new-connection"]),
          expect.anything(),
        );
        const payload = vi.mocked(context.broadcastToConnIds).mock.calls[0]?.[1];
        expect(payload).not.toHaveProperty("placement");
        expect(payload).not.toHaveProperty("session");
        expect(payload).not.toHaveProperty("label");
      } finally {
        release.resolve();
        await flushPendingSessionsChangedEvents(context);
      }
    },
  );

  it("keeps a removed generation and its replacement ordered behind an admitted read", async () => {
    const context = createContext();
    const sessionKey = "agent:main:generations";
    const first = activePlacement(sessionKey);
    let rowId = first.sessionId;
    mocks.loadRow.mockImplementation((key: string) => ({ key, sessionId: rowId }));
    const placements = new Map<string, WorkerSessionPlacementRecord>([[first.sessionId, first]]);
    const release = createDeferred();
    let reads = 0;
    let activeReads = 0;
    let maximumReads = 0;
    context.workerSessionPlacementService = {
      getMany: () => placements,
      readProjection: async () => {
        const snapshot = placementSnapshot(placements);
        maximumReads = Math.max(maximumReads, ++activeReads);
        try {
          if (++reads === 1) {
            await release.promise;
          }
          return snapshot;
        } finally {
          activeReads -= 1;
        }
      },
    };
    try {
      emitSessionsChanged(context, { reason: "old", sessionKey, sessionId: first.sessionId });
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(1);
      emitSessionsChanged(context, { reason: "delete", sessionKey, sessionId: first.sessionId });
      emitSessionsChanged(context, { reason: "delete", sessionKey, sessionId: first.sessionId });
      rowId = "replacement-generation";
      placements.clear();
      placements.set(rowId, {
        ...first,
        sessionId: rowId,
        generation: 2,
        environmentId: "worker-new",
      });
      emitSessionsChanged(context, { reason: "create", sessionKey, sessionId: rowId });
      emitSessionsChanged(context, { reason: "delete", sessionKey, sessionId: first.sessionId });
      const flushing = flushPendingSessionsChangedEvents(context);
      release.resolve();
      await flushing;
      const payloads = vi.mocked(context.broadcastToConnIds).mock.calls.map((call) => call[1]);
      expect(payloads).toMatchObject([
        { reason: "old" },
        { reason: "delete", sessionId: first.sessionId },
        { reason: "delete", sessionId: first.sessionId },
        { reason: "create", placement: { generation: 2, environmentId: "worker-new" } },
        { reason: "delete", sessionId: first.sessionId },
      ]);
      expect(payloads[0]).not.toHaveProperty("placement");
      expect(payloads[1]).not.toHaveProperty("placement");
      expect(payloads[2]).not.toHaveProperty("placement");
      expect(payloads[4]).not.toHaveProperty("placement");
      expect(maximumReads).toBe(1);
    } finally {
      release.resolve();
      await flushPendingSessionsChangedEvents(context);
    }
  });

  it("orders aliases of the same session behind one prepared publication", async () => {
    const context = createContext();
    const canonicalKey = "agent:main:main";
    const first = activePlacement(canonicalKey);
    mocks.loadRow.mockImplementation(() => ({ key: canonicalKey, sessionId: first.sessionId }));
    const placements = new Map<string, WorkerSessionPlacementRecord>([[first.sessionId, first]]);
    const release = createDeferred();
    let reads = 0;
    context.workerSessionPlacementService = {
      getMany: () => placements,
      readProjection: async () => {
        const snapshot = placementSnapshot(placements);
        if (++reads === 1) {
          await release.promise;
        }
        return snapshot;
      },
    };
    try {
      emitSessionsChanged(context, { reason: "alias", sessionKey: "main", agentId: "main" });
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(1);
      placements.set(first.sessionId, { ...first, generation: 2 });
      emitSessionsChanged(context, {
        reason: "canonical",
        sessionKey: canonicalKey,
        agentId: "main",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(1);
      const flushing = flushPendingSessionsChangedEvents(context);
      release.resolve();
      await flushing;
      const payloads = vi.mocked(context.broadcastToConnIds).mock.calls.map((call) => call[1]);
      expect(payloads[0]).not.toHaveProperty("placement");
      expect(payloads.at(-1)).toMatchObject({ reason: "canonical", placement: { generation: 2 } });
      expect(reads).toBe(2);
    } finally {
      release.resolve();
      await flushPendingSessionsChangedEvents(context);
    }
  });

  it("settles failed preparation as invalidation without poisoning the next notification", async () => {
    const context = createContext();
    const sessionKey = "agent:main:failed-read";
    const placement = activePlacement(sessionKey);
    context.workerSessionPlacementService = {
      getMany: () => new Map(),
      readProjection: vi
        .fn()
        .mockRejectedValueOnce(new Error("synthetic projection failure"))
        .mockResolvedValue(placementSnapshot(new Map([[placement.sessionId, placement]]))),
    };
    emitSessionsChanged(context, { reason: "first", sessionKey });
    await flushPendingSessionsChangedEvents(context);
    expect(vi.mocked(context.broadcastToConnIds).mock.calls[0]?.[1]).not.toHaveProperty(
      "placement",
    );
    emitSessionsChanged(context, { reason: "second", sessionKey });
    await flushPendingSessionsChangedEvents(context);
    expect(vi.mocked(context.broadcastToConnIds).mock.calls[1]?.[1]).toMatchObject({
      reason: "second",
      placement: { state: "active", environmentId: placement.environmentId },
    });
  });
});
