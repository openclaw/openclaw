import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { registerAgentRunCapacityWait } from "../infra/agent-run-capacity-wait.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
} from "../infra/agent-run-registry.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  createActiveRun,
  createGatewayBroadcaster,
  createLifecycleEventBroadcastHandler,
  expectAbsentFields,
  expectPrivateSessionInvalidation,
  fixedStoreRuntimeConfig,
  loadGatewaySessionEntryReadOnlyMock,
  loadGatewaySessionRowMock,
  ownerGoal,
  runtimeConfigState,
  sessionRow,
  subscribePluginSessionsChanged,
} from "./server-session-events.test-support.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";

function lifecycleFixture(
  subscriber = "observer",
  options: Partial<Parameters<typeof createLifecycleEventBroadcastHandler>[0]> = {},
) {
  const broadcastToConnIds = vi.fn();
  return {
    broadcastToConnIds,
    handler: createLifecycleEventBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set([subscriber]) },
      ...options,
    }),
  };
}

describe("createLifecycleEventBroadcastHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadGatewaySessionRowMock.mockReturnValue(sessionRow);
    runtimeConfigState.value = {};
    sessionRow.key = "agent:main:main";
    loadGatewaySessionEntryReadOnlyMock.mockReset().mockReturnValue({ entry: sessionRow });
  });
  it.each([
    ["participants", "session-entry"],
    ["run-capacity", "runtime"],
    ["swarm", undefined],
  ] as const)("carries the affected row for %s", async (reason, scope) => {
    const { broadcastToConnIds, handler } = lifecycleFixture();
    loadGatewaySessionRowMock.mockReturnValue({ ...sessionRow, swarm: undefined });
    await handler({ sessionKey: sessionRow.key, agentId: "main", reason, scope });
    expect(broadcastToConnIds.mock.calls[0]?.[1]).not.toHaveProperty("scope");
    expect(broadcastToConnIds.mock.calls[0]?.[1]).toMatchObject({
      reason,
      kind: "direct",
      session: { key: sessionRow.key, sessionId: sessionRow.sessionId },
      swarm: null,
    });
  });
  it.each([true, false])(
    "keeps lifecycle note fields with a projection present=%s",
    async (hasProjection) => {
      const query = { key: "agent:main:late-successor", agentId: "main" };
      const original = {
        sessionId: "original",
        updatedAt: 1,
        lifecycleRevision: "first",
        label: "Original row",
      };
      const note = {
        reason: "swarm-note",
        swarmGroupId: "original-swarm",
        kind: "log",
        text: "Original private note",
        label: "Old event label",
        displayName: "Old event display",
        parentSessionKey: "agent:main:old-parent",
      } as const;
      const projection = createSessionRowProjectionFixture({
        cfg: {},
        agentId: query.agentId,
        store: { [query.key]: original },
      });
      onTestFinished(() => projection.dispose());
      const { broadcastToConnIds, handler } = lifecycleFixture("reader", {
        getSessionRowProjection: () => (hasProjection ? projection : undefined),
      });
      await handler({
        agentId: query.agentId,
        sessionKey: query.key,
        ...note,
        catalogChanged: true,
      });
      expect(broadcastToConnIds).toHaveBeenCalledOnce();
      const payload = broadcastToConnIds.mock.calls[0]?.[1];
      expect(payload).toMatchObject({ ...note, sessionKey: query.key, catalogChanged: true });
      if (hasProjection) {
        expect(payload).toMatchObject({
          session: { sessionId: "original", lifecycleRevision: "first" },
        });
      } else {
        expect(payload).not.toHaveProperty("session");
      }
    },
  );

  it("keeps delayed key-only deletes as invalidations without borrowing a replacement", async () => {
    const { broadcastToConnIds, handler } = lifecycleFixture();
    await handler({ sessionKey: sessionRow.key, reason: "delete" });
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      { sessionKey: sessionRow.key, agentId: "main", reason: "delete", ts: expect.any(Number) },
      new Set(["observer"]),
      expect.any(Object),
    );
    expect(loadGatewaySessionRowMock).not.toHaveBeenCalled();
  });

  it("publishes lifecycle changes to plugins without websocket subscribers", async () => {
    const received = vi.fn();
    onTestFinished(subscribePluginSessionsChanged(received));
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(),
    });
    const handler = createLifecycleEventBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set() },
    });

    await handler({ sessionKey: "agent:main:main", reason: "rename", label: "Renamed session" });
    await Promise.resolve();
    expect(received).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      agentId: "main",
      label: "Renamed session",
      reason: "rename",
    });
  });

  it.each([
    { name: "projects configured persisted state without publishing its goal" },
    { name: "publishes active state and goal for the explicit owner", agentId: "ops" },
  ])("$name through capacity transitions without a refresh", async ({ agentId }) => {
    runtimeConfigState.value = fixedStoreRuntimeConfig("ops", ["ops", "research"]);
    sessionRow.key = "global";
    const goal = { ...ownerGoal };
    loadGatewaySessionRowMock.mockReturnValue({ ...sessionRow, goal });
    const activeRun = createActiveRun(true, true, {
      agentId: "ops",
      sessionKey: "global",
      sessionId: sessionRow.sessionId,
    });
    const { broadcastToConnIds, handler } = lifecycleFixture("conn-1");
    rpcSourceTesting.reset([["run-before-finalize", activeRun]]);

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
      {
        dropIfSlow: true,
        sessionEventSubscriptionKeys: ["agent:ops:global", "global"],
        prepareSessionProjection: expect.any(Function),
      },
    );
    const payload = broadcastToConnIds.mock.calls[0]?.[1];
    if (agentId) {
      expect(payload).toMatchObject({ agentId: "ops", goal });
    } else {
      expectAbsentFields(payload, "agentId goal session.goal");
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
    const { broadcastToConnIds, handler } = lifecycleFixture("conn-events");

    await handler({ sessionKey: "global", reason: "patch", catalogChanged: true });

    expect(loadGatewaySessionRowMock).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ sessionKey: "global", reason: "patch", catalogChanged: true }),
      new Set(["conn-events"]),
      {
        agentId: "ops",
        dropIfSlow: true,
        sessionEventSubscriptionKeys: ["agent:ops:global"],
        sessionKeys: ["agent:ops:global"],
      },
    );
    expectPrivateSessionInvalidation(broadcastToConnIds.mock.calls[0]?.[1]);
  });
});
