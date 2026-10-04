import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat.js";

const sessionFixture = vi.hoisted(() => ({ updatedAt: 50 }));

vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));
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

  function withReceiver(emit: (chatRunState: ReturnType<typeof createChatRunState>) => void) {
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
    const errors: unknown[] = [];
    const observe = (event: Parameters<typeof handler>[0]) => {
      try {
        handler(event);
      } catch (error) {
        errors.push(error);
      }
    };
    const unsubscribe = onAgentRuntimeEvent(observe);
    try {
      withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), () => emit(chatRunState));
    } finally {
      unsubscribe();
      handler.dispose();
      expect(errors).toEqual([]);
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

  it("preserves tool results for hidden session subscribers after cleanup", () => {
    const receiver = withReceiver(() => {
      registerAgentRunContext("late", {
        agentId: "delivery",
        sessionKey: "agent:delivery:late",
        sessionId: "session",
        isControlUiVisible: false,
        projectSessionMessages: true,
        verboseLevel: "full",
        registeredAt: 100,
      });
      clearAgentRunContext("late");
      emitToolResult("late");
    });
    const delivered = receiver.broadcastToConnIds.mock.calls.filter(([name]) => name === "agent");
    expect(delivered).toHaveLength(1);
    expect(receiver.broadcast).not.toHaveBeenCalled();
  });

  it("preserves run verbosity until a newer session preference replaces it", () => {
    const receiver = withReceiver(() => {
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

  it("uses the selected agent for newer global-session verbosity", () => {
    sessionFixture.updatedAt = 200;
    const receiver = withReceiver(() => {
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
