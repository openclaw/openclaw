// Tests for gateway runtime subscription wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
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

const auditTestState = vi.hoisted(() => ({
  enabled: true,
  created: 0,
  stopped: 0,
}));

vi.mock("../audit/audit-config.js", () => ({
  isAuditLedgerEnabled: () => auditTestState.enabled,
}));

vi.mock("../audit/agent-event-audit.js", () => ({
  createAgentEventAuditRecorder: () => {
    auditTestState.created += 1;
    return {
      record: vi.fn(),
      recordTool: vi.fn(),
      stop: vi.fn(async () => {
        auditTestState.stopped += 1;
      }),
    };
  },
}));

vi.mock("./server-chat.js", () => {
  throw new Error("server-chat lazy load failure");
});

vi.mock("./server-session-key.js", () => ({
  resolveSessionKeyForRun: () => "agent:main:main",
}));

vi.mock("./server-session-events.js", () => ({
  createTranscriptUpdateBroadcastHandler: () => () => {
    throw new Error("transcript handler failure");
  },
  createLifecycleEventBroadcastHandler: () => () => {
    throw new Error("lifecycle handler failure");
  },
}));

const { startGatewayEventSubscriptions } = await import("./server-runtime-subscriptions.js");
type SubscriptionParams = Parameters<typeof startGatewayEventSubscriptions>[0];

function createParams(): SubscriptionParams {
  return {
    log: mockLog,
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    nodeSendToSession: vi.fn(),
    agentRunSeq: new Map(),
    chatRunState: createChatRunState(),
    toolEventRecipients: createToolEventRecipientRegistry(),
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    chatAbortControllers: new Map(),
    restartRecoveryCandidates: new Map(),
  };
}

describe("startGatewayEventSubscriptions", () => {
  let unsubs: ReturnType<typeof startGatewayEventSubscriptions> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    auditTestState.enabled = true;
    auditTestState.created = 0;
    auditTestState.stopped = 0;
  });

  afterEach(() => {
    unsubs?.agentUnsub();
    unsubs?.heartbeatUnsub();
    unsubs?.transcriptUnsub();
    unsubs?.lifecycleUnsub();
    resetAgentEventsForTest();
  });

  it("records audit events by default and stops the recorder on unsubscribe", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    expect(auditTestState.created).toBe(1);
    await unsubs.agentUnsub();
    expect(auditTestState.stopped).toBe(1);
  });

  it("creates no audit recorder when audit.enabled is false", async () => {
    auditTestState.enabled = false;
    unsubs = startGatewayEventSubscriptions(createParams());

    expect(auditTestState.created).toBe(0);
    // Disabled wiring must still unsubscribe cleanly.
    await unsubs.agentUnsub();
    expect(auditTestState.stopped).toBe(0);
  });

  it("logs lazy agent event module failures", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: { phase: "start" } });

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      "Agent event dispatch failed",
      expect.objectContaining({ runId: "run-1", stream: "lifecycle" }),
    );
  });

  it("logs transcript handler failures", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    emitInternalSessionTranscriptUpdate({
      sessionFile: "/tmp/sess.jsonl",
      sessionKey: "agent:main:main",
    } as InternalSessionTranscriptUpdate);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      "Transcript update dispatch failed",
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
  });

  it("logs lifecycle handler failures", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    emitSessionLifecycleEvent({ sessionKey: "agent:main:main", reason: "created" });

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      "Lifecycle event dispatch failed",
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
  });
});
