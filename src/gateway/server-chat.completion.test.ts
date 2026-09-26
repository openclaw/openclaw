import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgentEventsForTest, type AgentEventRuntimePayload } from "../infra/agent-events.js";
import { emitAgentEvent, registerChatRun } from "./server-chat.agent-events.test-helpers.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
  type AgentEventHandlerOptions,
} from "./server-chat.js";
import type { GatewaySessionRow } from "./session-utils.js";

vi.mock("../config/io.js", () => ({ getRuntimeConfig: vi.fn(() => ({})) }));
vi.mock("./session-utils.js", () => ({
  loadGatewaySessionEntryReadOnly: vi.fn(() => ({
    cfg: {},
    store: {},
    canonicalKey: "agent:main:task:completion",
    storeKeys: [],
  })),
}));
const persistGatewaySessionLifecycleEventMock = vi.fn();
const loadGatewaySessionRow = vi.fn<() => GatewaySessionRow | null>();
const waitForFast = (callback: () => void) => vi.waitFor(callback, { interval: 1 });
beforeEach(() => {
  resetAgentEventsForTest({ preserveListeners: true });
  persistGatewaySessionLifecycleEventMock.mockReset().mockResolvedValue(undefined);
  loadGatewaySessionRow.mockReset().mockReturnValue(null);
});
function createHarness(
  params: Pick<AgentEventHandlerOptions, "resolveSessionKeyForRun" | "lifecycleErrorRetryGraceMs">,
) {
  const broadcastToConnIds = vi.fn();
  const chatRunState = createChatRunState();
  const sessionEventSubscribers = createSessionEventSubscriberRegistry();
  const handler = createAgentEventHandler({
    broadcast: vi.fn(),
    broadcastToConnIds,
    chatRunState,
    sessionEventSubscribers,
    nodeSendToSession: vi.fn(),
    nodeHasSessionSubscribers: () => false,
    agentRunSeq: new Map(),
    clearAgentRunContext: vi.fn(),
    toolEventRecipients: chatRunState.toolEventRecipients,
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    loadGatewaySessionLifecycleSnapshotForEvent: () => ({ row: loadGatewaySessionRow() }),
    persistGatewaySessionLifecycleEventForEvent: persistGatewaySessionLifecycleEventMock,
    ...params,
  });
  return { handler, chatRunState, sessionEventSubscribers, broadcastToConnIds };
}

describe("unattended run completion events", () => {
  it("does not announce a completion for a session reset during terminal persistence", async () => {
    const sessionKey = "agent:main:task:completion";
    const { handler, sessionEventSubscribers, broadcastToConnIds } = createHarness({
      resolveSessionKeyForRun: () => sessionKey,
    });
    sessionEventSubscribers.subscribe("roster-client");
    let finishPersistence = () => {};
    persistGatewaySessionLifecycleEventMock.mockReturnValue(
      new Promise<void>((resolve) => {
        finishPersistence = resolve;
      }),
    );
    emitAgentEvent(
      handler,
      "old-run",
      "lifecycle",
      { phase: "end", executionSettled: true },
      { sessionId: "old-session" },
    );
    vi.mocked(loadGatewaySessionRow).mockReturnValue({
      key: sessionKey,
      kind: "direct",
      sessionId: "new-session",
      updatedAt: 100,
    });
    finishPersistence();
    await waitForFast(() =>
      expect(
        broadcastToConnIds.mock.calls.filter(([event]) => event === "sessions.changed"),
      ).toHaveLength(1),
    );
    expect(
      broadcastToConnIds.mock.calls.filter(([event]) => event === "session.run.completed"),
    ).toEqual([]);
    handler.dispose();
  });

  it.each([false, true])(
    "publishes settled runs without transcript subscription (chat=%s)",
    async (chat) => {
      const sessionKey = "agent:main:task:completion";
      const { handler, chatRunState, sessionEventSubscribers, broadcastToConnIds } = createHarness({
        resolveSessionKeyForRun: () => sessionKey,
      });
      sessionEventSubscribers.subscribe("roster-client");
      if (chat) {
        registerChatRun(chatRunState, "source-run", sessionKey, "client-run", {
          agentId: "main",
        });
      }
      emitAgentEvent(handler, "source-run", "lifecycle", {
        phase: "end",
        executionSettled: true,
      });
      await waitForFast(() =>
        expect(broadcastToConnIds).toHaveBeenCalledWith(
          "session.run.completed",
          {
            sessionKey,
            agentId: "main",
            runId: chat ? "client-run" : "source-run",
            status: "ok",
          },
          new Set(["roster-client"]),
          { sessionKeys: [sessionKey], agentId: "main" },
        ),
      );
      // Later turns retain the same session, but have their own completion identity.
      emitAgentEvent(handler, "later-run", "lifecycle", { phase: "end", executionSettled: true });
      await waitForFast(() =>
        expect(
          broadcastToConnIds.mock.calls.filter(([event]) => event === "session.run.completed"),
        ).toHaveLength(2),
      );
      handler.dispose();
    },
  );

  it("does not announce parent yields, retry attempts, hidden runs, or heartbeats", async () => {
    const { handler, sessionEventSubscribers, broadcastToConnIds } = createHarness({
      resolveSessionKeyForRun: () => "agent:main:task:completion",
      lifecycleErrorRetryGraceMs: 0,
    });
    sessionEventSubscribers.subscribe("roster-client");
    emitAgentEvent(handler, "yield-run", "lifecycle", {
      phase: "end",
      executionSettled: true,
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
    });
    emitAgentEvent(handler, "retry-run", "lifecycle", { phase: "error", error: "retryable" });
    const publishRuntime = (event: AgentEventRuntimePayload) => handler(event);
    publishRuntime({
      runId: "hidden-run",
      seq: 1,
      ts: Date.now(),
      stream: "lifecycle",
      controlUiVisible: false,
      data: { phase: "end", executionSettled: true },
    });
    publishRuntime({
      runId: "heartbeat-run",
      seq: 1,
      ts: Date.now(),
      stream: "lifecycle",
      isHeartbeat: true,
      data: { phase: "end", executionSettled: true },
    });
    await waitForFast(() =>
      expect(
        broadcastToConnIds.mock.calls.filter(([event]) => event === "sessions.changed"),
      ).toHaveLength(4),
    );
    expect(
      broadcastToConnIds.mock.calls.filter(([event]) => event === "session.run.completed"),
    ).toEqual([]);
    handler.dispose();
  });

  it("deduplicates terminals and retires publication when disposed during persistence", async () => {
    const { handler, sessionEventSubscribers, broadcastToConnIds } = createHarness({
      resolveSessionKeyForRun: () => "agent:main:task:completion",
    });
    sessionEventSubscribers.subscribe("roster-client");
    for (let index = 0; index < 2; index++) {
      emitAgentEvent(handler, "same-run", "lifecycle", { phase: "end", executionSettled: true });
    }
    await waitForFast(() =>
      expect(
        broadcastToConnIds.mock.calls.filter(([event]) => event === "sessions.changed"),
      ).toHaveLength(2),
    );
    expect(
      broadcastToConnIds.mock.calls.filter(([event]) => event === "session.run.completed"),
    ).toHaveLength(1);
    emitAgentEvent(handler, "disposed-run", "lifecycle", {
      phase: "end",
      executionSettled: true,
    });
    handler.dispose();
    await Promise.resolve();
    expect(
      broadcastToConnIds.mock.calls.filter(([event]) => event === "sessions.changed"),
    ).toHaveLength(2);
    expect(
      broadcastToConnIds.mock.calls.filter(([event]) => event === "session.run.completed"),
    ).toHaveLength(1);
  });
});
