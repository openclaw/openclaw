// Tests for gateway runtime subscription wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { emitHeartbeatEvent, resetHeartbeatEventsForTest } from "../infra/heartbeat-events.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  emitInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
  createToolEventRecipientRegistry,
} from "./server-chat-state.js";

const warn = vi.fn();
const mockLog: SubsystemLogger = {
  subsystem: "gateway-test",
  isEnabled: () => true,
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn,
  error: vi.fn(),
  fatal: vi.fn(),
  raw: vi.fn(),
  child: () => mockLog,
};

vi.mock("./server-chat.js", () => {
  return {
    createAgentEventHandler: () => {
      throw new Error("server-chat lazy load failure");
    },
  };
});

vi.mock("./server-session-key.js", () => {
  return {
    resolveSessionKeyForRun: () => "agent:main:main",
  };
});

vi.mock("./server-session-events.js", () => {
  return {
    createTranscriptUpdateBroadcastHandler: () => {
      throw new Error("server-session-events lazy load failure");
    },
    createLifecycleEventBroadcastHandler: () => {
      throw new Error("server-session-events lazy load failure");
    },
  };
});

const { startGatewayEventSubscriptions } = await import("./server-runtime-subscriptions.js");

function createParams() {
  return {
    log: mockLog,
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    nodeSendToSession: vi.fn(),
    agentRunSeq: new Map<string, number>(),
    chatRunState: createChatRunState(),
    toolEventRecipients: createToolEventRecipientRegistry(),
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    chatAbortControllers: new Map<string, unknown>(),
    restartRecoveryCandidates: new Map<string, unknown>(),
  };
}

describe("startGatewayEventSubscriptions", () => {
  let unsubs: ReturnType<typeof startGatewayEventSubscriptions>;
  const unhandledRejections: unknown[] = [];
  let unhandledHandler: (reason: unknown) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    unhandledHandler = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", unhandledHandler);
  });

  afterEach(() => {
    process.off("unhandledRejection", unhandledHandler);
    unsubs?.agentUnsub();
    unsubs?.heartbeatUnsub();
    unsubs?.transcriptUnsub();
    unsubs?.lifecycleUnsub();
    resetAgentEventsForTest();
    resetHeartbeatEventsForTest();
  });

  it("logs a warning when the lazy agent event handler import rejects", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: { phase: "start" } });

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      "Failed to handle agent event: lazy handler load rejected",
      expect.objectContaining({ runId: "run-1", stream: "lifecycle" }),
    );
    expect(unhandledRejections).toHaveLength(0);
  });

  it("logs a warning when the lazy transcript update handler import rejects", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    emitInternalSessionTranscriptUpdate({
      sessionFile: "/tmp/sess.jsonl",
      sessionKey: "agent:main:main",
    } as InternalSessionTranscriptUpdate);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      "Failed to handle transcript update: lazy handler load rejected",
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
    expect(unhandledRejections).toHaveLength(0);
  });

  it("logs a warning when the lazy lifecycle event handler import rejects", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    emitSessionLifecycleEvent({ sessionKey: "agent:main:main", reason: "created" });

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      "Failed to handle lifecycle event: lazy handler load rejected",
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
    expect(unhandledRejections).toHaveLength(0);
  });

  it("still broadcasts heartbeat events directly without lazy loading", async () => {
    const params = createParams();
    unsubs = startGatewayEventSubscriptions(params);

    emitHeartbeatEvent({ status: "ok-empty" });

    await vi.waitFor(() => expect(params.broadcast).toHaveBeenCalledTimes(1));
    expect(params.broadcast).toHaveBeenCalledWith("heartbeat", expect.anything(), {
      dropIfSlow: true,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
