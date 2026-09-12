import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { registerChatRun } from "./server-chat.agent-events.test-helpers.js";
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
    loadGatewaySessionLifecycleSnapshot: () => ({ row: null }),
  };
});

describe("retired execution event projection", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
    sessionFixture.updatedAt = 50;
  });

  function createReceiver() {
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const chatRunState = createChatRunState();
    const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
    sessionMessageSubscribers.subscribe("selected", "agent:delivery:late");
    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
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
    const errors: unknown[] = [];
    const observe = (event: Parameters<typeof handler>[0]) => {
      try {
        handler(event);
      } catch (error) {
        errors.push(error);
      }
    };
    return {
      handler,
      observe,
      errors,
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      chatRunState,
    };
  }

  it.each([false, true])("preserves hidden heartbeat tool suppression (%s)", (isHeartbeat) => {
    const receiver = createReceiver();
    const unsubscribe = onAgentRuntimeEvent(receiver.observe);
    try {
      withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), () => {
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
        emitAgentEvent({
          runId: "late",
          stream: "tool",
          data: {
            phase: "result",
            name: "read",
            toolCallId: "finished",
            result: { value: "retained" },
          },
        });
      });
    } finally {
      unsubscribe();
      receiver.handler.dispose();
      expect(receiver.errors).toEqual([]);
    }
    const delivered = receiver.broadcastToConnIds.mock.calls.filter(([name]) => name === "agent");
    expect(delivered).toHaveLength(isHeartbeat ? 0 : 1);
    expect(receiver.broadcast).not.toHaveBeenCalled();
  });

  it("preserves run verbosity until a newer session preference replaces it", () => {
    const receiver = createReceiver();
    const unsubscribe = onAgentRuntimeEvent(receiver.observe);
    try {
      withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), () => {
        registerAgentRunContext("verbose", {
          agentId: "delivery",
          sessionKey: "agent:delivery:late",
          sessionId: "session",
          verboseLevel: "full",
          registeredAt: 100,
        });
        clearAgentRunContext("verbose");
        emitAgentEvent({
          runId: "verbose",
          stream: "tool",
          data: {
            phase: "result",
            name: "read",
            toolCallId: "finished",
            result: { value: "retained" },
          },
        });
      });
    } finally {
      unsubscribe();
      receiver.handler.dispose();
      expect(receiver.errors).toEqual([]);
    }
    const delivered = receiver.nodeSendToSession.mock.calls.filter(([, name]) => name === "agent");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.[2]).toMatchObject({ data: { result: { value: "retained" } } });
  });

  const alert = `Service outage requires action. ${"Repair is still required. ".repeat(20)}`;
  it.each([
    { text: "HEARTBEAT_OK", expected: undefined },
    { text: `HEARTBEAT_OK ${alert}`, expected: alert.trim() },
  ])("preserves heartbeat final ACK/alert policy after cleanup ($text)", ({ text, expected }) => {
    const receiver = createReceiver();
    const unsubscribe = onAgentRuntimeEvent(receiver.observe);
    try {
      withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), () => {
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
    } finally {
      unsubscribe();
      receiver.handler.dispose();
      expect(receiver.errors).toEqual([]);
    }
    const chat = receiver.broadcast.mock.calls.filter(([name]) => name === "chat");
    expect(chat.filter(([, payload]) => payload.state === "delta")).toEqual([]);
    const final = chat.filter(([, payload]) => payload.state === "final");
    expect(final).toHaveLength(1);
    if (expected) {
      expect(final[0]?.[1]).toMatchObject({ message: { content: [{ text: expected }] } });
    } else {
      expect(final[0]?.[1].message).toBeUndefined();
    }
  });

  it.each([false, undefined])(
    "keeps heartbeat alias suppression separate from source flags (%s)",
    (sourceFlag) => {
      const receiver = createReceiver();
      const unsubscribe = onAgentRuntimeEvent(receiver.observe);
      try {
        withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), () => {
          registerAgentRunContext("client", {
            agentId: "delivery",
            sessionKey: "agent:delivery:late",
            isHeartbeat: true,
          });
          registerAgentRunContext("source", {
            agentId: "delivery",
            sessionKey: "agent:delivery:late",
            isHeartbeat: sourceFlag,
            verboseLevel: "full",
          });
          registerChatRun(receiver.chatRunState, "source", "agent:delivery:late", "client", {
            agentId: "delivery",
          });
          emitAgentEvent({
            runId: "source",
            stream: "assistant",
            data: { text: "A source event", delta: "A source event" },
          });
          emitAgentEvent({
            runId: "source",
            stream: "tool",
            data: {
              phase: "result",
              name: "read",
              toolCallId: "late",
              result: { value: "retained" },
            },
          });
        });
      } finally {
        unsubscribe();
        receiver.handler.dispose();
        expect(receiver.errors).toEqual([]);
      }
      const source = receiver.broadcast.mock.calls.find(
        ([name, payload]) => name === "agent" && payload.stream === "assistant",
      )?.[1];
      expect(source).toBeDefined();
      if (sourceFlag === undefined) {
        expect(source).not.toHaveProperty("isHeartbeat");
      } else {
        expect(source).toHaveProperty("isHeartbeat", sourceFlag);
      }
      expect(
        receiver.nodeSendToSession.mock.calls.filter(
          ([, name, payload]) => name === "agent" && payload.stream === "tool",
        ),
      ).toEqual([]);
    },
  );

  it("uses the selected agent for newer global-session verbosity", () => {
    sessionFixture.updatedAt = 200;
    const receiver = createReceiver();
    const unsubscribe = onAgentRuntimeEvent(receiver.observe);
    try {
      withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), () => {
        registerAgentRunContext("global-run", {
          agentId: "delivery",
          sessionKey: "global",
          verboseLevel: "full",
          registeredAt: 100,
        });
        clearAgentRunContext("global-run");
        emitAgentEvent({
          runId: "global-run",
          stream: "tool",
          data: {
            phase: "result",
            name: "read",
            toolCallId: "late",
            result: { value: "retained" },
          },
        });
      });
    } finally {
      unsubscribe();
      receiver.handler.dispose();
      expect(receiver.errors).toEqual([]);
    }
    expect(receiver.nodeSendToSession.mock.calls.filter(([, name]) => name === "agent")).toEqual(
      [],
    );
  });
});
