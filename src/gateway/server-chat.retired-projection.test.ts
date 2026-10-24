import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { subscribeAgentEvents } from "./server-chat.agent-events.test-helpers.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";

const sessionFixture = vi.hoisted(() => ({ updatedAt: 50 }));

// mock-isolation: Session owners are synthetic; the fixture must not load operator configuration.
vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => ({ agents: { entries: { main: {}, delivery: {} } } }),
}));

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
    const entry = {
      sessionId: "session",
      verboseLevel: "off" as const,
      updatedAt: sessionFixture.updatedAt,
    };
    const projection = createSessionRowProjectionFixture({
      cfg: getRuntimeConfig(),
      agentId: "delivery",
      store: { global: entry, "agent:delivery:late": entry },
    });
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
      getSessionRowProjection: () => projection,
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
        projection.dispose();
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

  it("preserves tool results for hidden session subscribers after cleanup", async () => {
    const receiver = await withReceiver(() => {
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
