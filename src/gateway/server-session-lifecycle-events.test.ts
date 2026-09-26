import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { registerAgentRunCapacityWait } from "../infra/agent-run-capacity-wait.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
} from "../infra/agent-run-registry.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  createActiveRun,
  createGatewayBroadcaster,
  createLifecycleEventBroadcastHandler,
  expectPrivateSessionInvalidation,
  fixedStoreRuntimeConfig,
  loadGatewaySessionEntryReadOnlyMock,
  loadGatewaySessionRowMock,
  ownerGoal,
  resolveEmbeddedAgentSessionProgressStateMock,
  runtimeConfigState,
  sessionRow,
  subscribePluginSessionsChanged,
} from "./server-session-events.test-support.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { SessionRowProjection } from "./session-row-projection.js";

describe("createLifecycleEventBroadcastHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveEmbeddedAgentSessionProgressStateMock.mockReturnValue(undefined);
    loadGatewaySessionRowMock.mockReturnValue(sessionRow);
    runtimeConfigState.value = {};
    sessionRow.key = "agent:main:main";
    loadGatewaySessionEntryReadOnlyMock.mockReset().mockReturnValue({ entry: sessionRow });
  });
  it.each([
    "participants",
    "subagent-status",
    "run-capacity",
    "swarm",
    "swarm-note",
    "github-publication",
    "worker-disk-space",
  ])("carries the affected row for %s", async (reason) => {
    const broadcastToConnIds = vi.fn();
    const handler = createLifecycleEventBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["observer"]) },
      chatAbortControllers: new Map(),
    });
    await handler({
      sessionKey: sessionRow.key,
      agentId: "main",
      reason,
      ...(["swarm", "swarm-note", "run-capacity"].includes(reason)
        ? { scope: "runtime" as const }
        : {}),
    });
    expect(broadcastToConnIds.mock.calls[0]?.[1]).not.toHaveProperty("scope");
    expect(broadcastToConnIds.mock.calls[0]?.[1]).toMatchObject({
      reason,
      session: { key: sessionRow.key, sessionId: sessionRow.sessionId },
    });
  });
  it.each([
    {
      name: "missing capture followed by a successor",
      captured: false,
      projection: true,
      delivered: false,
    },
    { name: "current capture", captured: true, projection: true, delivered: true },
    { name: "no-projection fallback", captured: false, projection: false, delivered: true },
  ])("keeps lifecycle publication identity for $name", async (scenario) => {
    const prepared = createDeferred();
    const query = { key: "agent:main:late-successor", agentId: "main" };
    const original = { ...query, entry: { sessionId: "original", lifecycleRevision: "first" } };
    let current = scenario.captured ? original : undefined;
    let generation = 0;
    const snapshot = vi.fn(() => ({
      row: current ? { ...current.entry, key: query.key, kind: "direct" } : null,
    }));
    const projection = {
      state: { rowContext: { projectedAgentRuns: undefined } },
      capture: () => current,
      ensureMaterialized: async () => {},
      withPreparedExactRows: (async (queries, consume) => {
        queries({});
        await prepared.promise;
        return { kind: "complete", value: consume(projection) };
      }) satisfies SessionRowProjection["withPreparedExactRows"],
      isCurrent: (record: typeof original) => record === current,
      observeGeneration: (() => {
        const observed = generation;
        return { isCurrent: () => generation === observed, dispose() {} };
      }) satisfies SessionRowProjection["observeGeneration"],
      snapshot,
    } as unknown as SessionRowProjection;
    const broadcastToConnIds = vi.fn();
    const handler = createLifecycleEventBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["reader"]) },
      chatAbortControllers: new Map(),
      getSessionRowProjection: () => (scenario.projection ? projection : undefined),
    });
    const pending = handler({ sessionKey: query.key, agentId: query.agentId, reason: "updated" });
    if (scenario.projection) {
      expect(broadcastToConnIds).not.toHaveBeenCalled();
    }
    if (!scenario.captured) {
      generation += 1;
      current = { ...query, entry: { sessionId: "successor", lifecycleRevision: "next" } };
    }
    prepared.resolve();
    await pending;
    if (!scenario.delivered) {
      expect(snapshot).not.toHaveBeenCalled();
      expect(broadcastToConnIds).not.toHaveBeenCalled();
    } else {
      expect(broadcastToConnIds).toHaveBeenCalledOnce();
      const payload = broadcastToConnIds.mock.calls[0]?.[1];
      expect(payload).toMatchObject({ sessionKey: query.key, reason: "updated" });
      if (scenario.projection) {
        expect(payload).toMatchObject({
          session: { sessionId: "original", lifecycleRevision: "first" },
        });
      } else {
        expect(payload).not.toHaveProperty("session");
      }
    }
  });

  it("keeps delayed key-only deletes as invalidations without borrowing a replacement", async () => {
    const broadcastToConnIds = vi.fn();
    const handler = createLifecycleEventBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["observer"]) },
      chatAbortControllers: new Map(),
    });
    await handler({ sessionKey: sessionRow.key, reason: "delete" });
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      { sessionKey: sessionRow.key, agentId: "main", reason: "delete", ts: expect.any(Number) },
      new Set(["observer"]),
      expect.any(Object),
    );
    expect(loadGatewaySessionRowMock).not.toHaveBeenCalled();
  });

  it.each(["swarm", "run-capacity"])(
    "includes complete collector counts for committed parent changes (%s)",
    async (reason) => {
      const broadcastToConnIds = vi.fn();
      loadGatewaySessionRowMock.mockImplementation(() => ({
        ...sessionRow,
        swarm: undefined,
      }));
      const handler = createLifecycleEventBroadcastHandler({
        broadcastToConnIds,
        sessionEventSubscribers: { getAll: () => new Set(["observer"]) },
        chatAbortControllers: new Map(),
      });

      await handler({ sessionKey: sessionRow.key, agentId: "main", reason });

      expect(loadGatewaySessionRowMock).toHaveBeenCalledExactlyOnceWith(sessionRow.key, {
        agentId: "main",
      });
      const payload = broadcastToConnIds.mock.calls[0]?.[1];
      expect(payload).toHaveProperty("swarm", null);
    },
  );

  it.each(["phase", "log"] as const)("projects swarm %s payload fields", async (kind) => {
    const broadcastToConnIds = vi.fn();
    const handler = createLifecycleEventBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["conn-1"]) },
      chatAbortControllers: new Map(),
    });

    await handler({
      sessionKey: "agent:main:main",
      reason: "swarm-note",
      swarmGroupId: "swarm:agent:main:main:run-1",
      kind,
      text: "Research",
    });

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        swarmGroupId: "swarm:agent:main:main:run-1",
        kind,
        text: "Research",
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
  });

  it("publishes lifecycle changes to plugins without websocket subscribers", async () => {
    const received = vi.fn();
    const unsubscribe = subscribePluginSessionsChanged(received);
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(),
    });
    const handler = createLifecycleEventBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set() },
      chatAbortControllers: new Map(),
    });

    try {
      await handler({
        sessionKey: "agent:main:main",
        reason: "rename",
        label: "Renamed session",
      });
      await Promise.resolve();
      expect(received).toHaveBeenCalledWith({
        sessionKey: "agent:main:main",
        agentId: "main",
        label: "Renamed session",
        reason: "rename",
      });
    } finally {
      unsubscribe();
    }
  });

  it.each([
    { name: "projects configured persisted state without publishing its goal" },
    { name: "publishes active state and goal for the explicit owner", agentId: "ops" },
  ])("$name through capacity transitions without a refresh", async ({ agentId }) => {
    runtimeConfigState.value = fixedStoreRuntimeConfig("ops", ["ops", "research"]);
    sessionRow.key = "global";
    const goal = { ...ownerGoal };
    loadGatewaySessionRowMock.mockReturnValue({ ...sessionRow, goal });
    const activeRun = {
      ...createActiveRun(true),
      agentId: "ops",
      sessionKey: "global",
    };
    const broadcastToConnIds = vi.fn();
    const handler = createLifecycleEventBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["conn-1"]) },
      chatAbortControllers: new Map([["run-before-finalize", activeRun]]),
    });

    await handler({ sessionKey: "global", ...(agentId ? { agentId } : {}), reason: "updated" });

    expect(loadGatewaySessionRowMock).toHaveBeenCalledWith("global", { agentId: "ops" });
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        sessionKey: "global",
        hasActiveRun: true,
        activeRunIds: ["run-before-finalize"],
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
    const payload = broadcastToConnIds.mock.calls[0]?.[1];
    if (agentId) {
      expect(payload).toMatchObject({ agentId: "ops", goal });
    } else {
      expect(payload).not.toHaveProperty("agentId");
      expect(payload).not.toHaveProperty("goal");
      expect(payload).not.toHaveProperty("session.goal");
    }
    const runId = "run-before-finalize";
    registerAgentRunContext(runId, { sessionKey: "global", agentId: "ops" });
    const publications: Promise<void>[] = [];
    const unsubscribe = onSessionLifecycleEvent((event) => {
      publications.push(handler(event));
    });
    const releaseWait = registerAgentRunCapacityWait(runId, getAgentRunLifecycleGeneration());
    try {
      releaseWait?.();
      await Promise.all(publications);
      const transitions = broadcastToConnIds.mock.calls.slice(1);
      expect(
        transitions.map(([, event]) => [event.reason, event.status, event.hasActiveRun]),
      ).toEqual([
        ["run-capacity", "queued", true],
        ["run-capacity", "running", true],
      ]);
    } finally {
      unsubscribe();
      releaseWait?.();
      try {
        await Promise.all(publications);
      } finally {
        clearAgentRunContext(runId);
      }
    }
  });

  it("publishes only a private invalidation for a retired fixed-store lifecycle owner", async () => {
    runtimeConfigState.value = fixedStoreRuntimeConfig("ops", ["research"]);
    const broadcastToConnIds = vi.fn();
    const handler = createLifecycleEventBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["conn-events"]) },
      chatAbortControllers: new Map(),
    });

    await handler({ sessionKey: "global", reason: "patch", catalogChanged: true });

    expect(loadGatewaySessionRowMock).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ sessionKey: "global", reason: "patch", catalogChanged: true }),
      new Set(["conn-events"]),
      {
        agentId: "ops",
        dropIfSlow: true,
        sessionKeys: ["agent:ops:global"],
      },
    );
    expectPrivateSessionInvalidation(broadcastToConnIds.mock.calls[0]?.[1]);
  });
});
