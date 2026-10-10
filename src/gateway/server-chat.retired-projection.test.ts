import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { registerChatRun, subscribeAgentEvents } from "./server-chat.agent-events.test-helpers.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat.js";

const sessionFixture = vi.hoisted(() => ({ updatedAt: 50 }));

vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../infra/heartbeat-visibility.js", () => ({
  resolveHeartbeatVisibility: () => ({ showOk: false, showAlerts: true, useIndicator: true }),
}));
vi.mock("./session-utils.js", async () => {
  const { resolveSessionStoreIdentity } = await import("./session-store-key.js");
  return {
    loadGatewaySessionEntryReadOnly: (sessionKey: string, options?: { agentId?: string }) => {
      const cfg = { agents: { entries: { main: {}, delivery: {} } } };
      const identity = resolveSessionStoreIdentity({ cfg, sessionKey, agentId: options?.agentId });
      return {
        cfg,
        ...identity,
        store: {},
        entry: { sessionId: "session", verboseLevel: "off", updatedAt: sessionFixture.updatedAt },
      };
    },
  };
});

describe("retired execution event projection", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
    sessionFixture.updatedAt = 50;
  });

  async function withReceiver(emit: (chatRunState: ReturnType<typeof createChatRunState>) => void) {
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const chatRunState = createChatRunState();
    const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
    sessionMessageSubscribers.subscribe("selected", "agent:delivery:late");
    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeHasSessionSubscribers: () => true,
      nodeSendToSession,
      chatRunState,
      agentRunSeq: new Map(),
      toolEventRecipients: chatRunState.toolEventRecipients,
      sessionMessageSubscribers,
      sessionEventSubscribers: createSessionEventSubscriberRegistry(),
      clearAgentRunContext,
      resolveSessionKeyForRun: () => {
        throw new Error("Event lost its producer route");
      },
      loadGatewaySessionLifecycleSnapshotForEvent: () => ({ row: null }),
      persistGatewaySessionLifecycleEventForEvent: async () => {},
    });
    const unsubscribe = subscribeAgentEvents(async (event) => {
      await handler(event);
    });
    try {
      withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), () => emit(chatRunState));
    } finally {
      try {
        await unsubscribe();
      } finally {
        await handler.dispose();
      }
    }
    return { broadcast, broadcastToConnIds, nodeSendToSession };
  }

  function emitToolResult(runId: string, toolCallId = "finished") {
    emitAgentEvent({
      runId,
      stream: "tool",
      data: { phase: "result", name: "read", toolCallId, result: { value: "retained" } },
    });
  }

  it.each([false, true])(
    "preserves hidden heartbeat tool suppression (%s)",
    async (isHeartbeat) => {
      const receiver = await withReceiver(() => {
        registerAgentRunContext("late", {
          agentId: "delivery",
          sessionKey: "agent:delivery:late",
          sessionId: "session",
          isControlUiVisible: false,
          projectSessionMessages: true,
          isHeartbeat,
          verboseLevel: "full",
          registeredAt: 100,
        });
        clearAgentRunContext("late");
        emitToolResult("late");
      });
      const delivered = receiver.broadcastToConnIds.mock.calls.filter(([name]) => name === "agent");
      expect(delivered).toHaveLength(isHeartbeat ? 0 : 1);
      expect(receiver.broadcast).not.toHaveBeenCalled();
    },
  );

  it("preserves run verbosity until a newer session preference replaces it", async () => {
    const receiver = await withReceiver(() => {
      registerAgentRunContext("verbose", {
        agentId: "delivery",
        sessionKey: "agent:delivery:late",
        sessionId: "session",
        verboseLevel: "full",
        registeredAt: 100,
      });
      clearAgentRunContext("verbose");
      emitToolResult("verbose");
    });
    const delivered = receiver.nodeSendToSession.mock.calls.filter(([, name]) => name === "agent");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.[2]).toMatchObject({ data: { result: { value: "retained" } } });
  });

  const alert = `Service outage requires action. ${"Repair is still required. ".repeat(20)}`;
  it.each([
    { text: "HEARTBEAT_OK", expected: undefined },
    { text: `HEARTBEAT_OK ${alert}`, expected: alert.trim() },
  ])(
    "preserves heartbeat final ACK/alert policy after cleanup ($text)",
    async ({ text, expected }) => {
      const receiver = await withReceiver(() => {
        registerAgentRunContext("heartbeat", {
          agentId: "delivery",
          sessionKey: "agent:delivery:late",
          sessionId: "session",
          isHeartbeat: true,
        });
        clearAgentRunContext("heartbeat");
        emitAgentEvent({ runId: "heartbeat", stream: "assistant", data: { text, delta: text } });
        emitAgentEvent({ runId: "heartbeat", stream: "lifecycle", data: { phase: "end" } });
      });
      const chat = receiver.broadcast.mock.calls.filter(([name]) => name === "chat");
      expect(chat.filter(([, payload]) => payload.state === "delta")).toEqual([]);
      const final = chat.filter(([, payload]) => payload.state === "final");
      expect(final).toHaveLength(1);
      if (expected) {
        expect(final[0]?.[1]).toMatchObject({ message: { content: [{ text: expected }] } });
      } else {
        expect(final[0]?.[1].message).toBeUndefined();
      }
    },
  );

  it("keeps heartbeat alias suppression separate from explicit source flags", async () => {
    const receiver = await withReceiver((chatRunState) => {
      registerAgentRunContext("client", {
        agentId: "delivery",
        sessionKey: "agent:delivery:late",
        isHeartbeat: true,
      });
      registerAgentRunContext("source", {
        agentId: "delivery",
        sessionKey: "agent:delivery:late",
        isHeartbeat: false,
        verboseLevel: "full",
      });
      registerChatRun(chatRunState, "source", "agent:delivery:late", "client", {
        agentId: "delivery",
      });
      emitAgentEvent({
        runId: "source",
        stream: "assistant",
        data: { text: "A source event", delta: "A source event" },
      });
      emitToolResult("source", "late");
    });
    const source = receiver.broadcast.mock.calls.find(
      ([name, payload]) => name === "agent" && payload.stream === "assistant",
    )?.[1];
    expect(source).toBeDefined();
    expect(source).toHaveProperty("isHeartbeat", false);
    expect(
      receiver.nodeSendToSession.mock.calls.filter(
        ([, name, payload]) => name === "agent" && payload.stream === "tool",
      ),
    ).toEqual([]);
  });

  it("uses the selected agent for newer global-session verbosity", async () => {
    sessionFixture.updatedAt = 200;
    const receiver = await withReceiver(() => {
      registerAgentRunContext("global-run", {
        agentId: "delivery",
        sessionKey: "global",
        verboseLevel: "full",
        registeredAt: 100,
      });
      clearAgentRunContext("global-run");
      emitToolResult("global-run", "late");
    });
    expect(receiver.nodeSendToSession.mock.calls.filter(([, name]) => name === "agent")).toEqual(
      [],
    );
  });
});
