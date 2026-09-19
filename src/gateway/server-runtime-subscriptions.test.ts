// Tests for gateway runtime subscription wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelParticipantAdmissionEvidence } from "../../test/helpers/channel-admission-evidence.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  configureExecutionIdentityAdmissionSink,
  enqueueExecutionIdentityContextAtAdmission,
  hasExecutionIdentityAdmissionSink,
} from "../audit/execution-identity-admission.js";
import { consumeChannelAdmissionEvidence } from "../channels/message-access/admission-evidence.js";
import {
  type AgentEventPayload,
  emitAgentAuditEvent,
  emitAgentEvent,
  emitAgentEventForOwner,
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import {
  claimAgentRunContext,
  getAgentRunContextOwnerStatus as ownerStatus,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  emitSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { installInMemoryTaskRegistryRuntime } from "../test-utils/task-registry-runtime.js";
import { abortChatRunById, registerChatAbortController } from "./chat-abort.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import type { AgentEventHandlerOptions } from "./server-chat.js";
import { registerTaskEventSubscriptionTests } from "./server-runtime-subscriptions.task-events.test-support.js";
import { registerTaskSubscriptionOwnershipTests } from "./server-runtime-subscriptions.task-ownership.test-support.js";
import { lifecycleState, readLifecycleState } from "./server-runtime-subscriptions.test-support.js";
import type { SessionRowProjection } from "./session-row-projection.js";

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

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
  messageMode: "off" as "off" | "direct" | "all",
  created: 0,
  recorded: 0,
  identityRecorded: 0,
  decisionRecorded: 0,
  executionIdentityEnabled: false,
  stopped: 0,
}));
const agentEventHandlerMocks = vi.hoisted(() => ({
  create: vi.fn(),
  persistLifecycle: vi.fn(async () => {}),
  resolveSessionKey: vi.fn(() => "agent:main:main"),
}));
const transcriptBroadcastMocks = vi.hoisted(() => ({
  useActualHandler: false,
  readMessageById: vi.fn(),
}));
const runtimeConfigState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const observeActivitySummary = vi.hoisted(() =>
  vi.fn<
    (
      options: Parameters<
        typeof import("./session-activity-summaries.js").createSessionActivitySummaries
      >[0],
    ) => void
  >(),
);

vi.mock("./session-activity-summaries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-activity-summaries.js")>();
  return {
    ...actual,
    createSessionActivitySummaries: (
      options: Parameters<typeof actual.createSessionActivitySummaries>[0],
    ) => {
      observeActivitySummary(options);
      return actual.createSessionActivitySummaries(options);
    },
  };
});

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => runtimeConfigState.value,
}));

vi.mock("../audit/audit-config.js", () => ({
  isAuditLedgerEnabled: () => auditTestState.enabled,
  isExecutionIdentityCollectionEnabled: () => auditTestState.executionIdentityEnabled,
  resolveAuditMessageMode: () => auditTestState.messageMode,
}));

vi.mock("../audit/audit-recorder.js", () => ({
  createAuditEventRecorder: () => {
    auditTestState.created += 1;
    return {
      record: vi.fn(() => {
        auditTestState.recorded += 1;
      }),
      recordTool: vi.fn(),
      recordMessage: vi.fn(),
      recordExecutionIdentity: vi.fn(() => {
        auditTestState.identityRecorded += 1;
        return true;
      }),
      recordExecutionDecision: vi.fn(() => {
        auditTestState.decisionRecorded += 1;
        return true;
      }),
      stop: vi.fn(async () => {
        auditTestState.stopped += 1;
      }),
    };
  },
}));

vi.mock("./server-chat.js", () => ({
  createAgentEventHandler: (...args: unknown[]) => agentEventHandlerMocks.create(...args),
}));

vi.mock("./session-lifecycle-state.js", () => ({
  persistGatewaySessionLifecycleEvent: agentEventHandlerMocks.persistLifecycle,
}));

vi.mock("./server-session-key.js", () => ({
  resolveSessionKeyForRun: agentEventHandlerMocks.resolveSessionKey,
}));

vi.mock("./session-transcript-readers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-transcript-readers.js")>();
  return {
    ...actual,
    readSessionMessageByIdAsync: transcriptBroadcastMocks.readMessageById,
  };
});

vi.mock("./server-session-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-session-events.js")>();
  return {
    ...actual,
    createTranscriptUpdateBroadcastHandler: (
      ...args: Parameters<typeof actual.createTranscriptUpdateBroadcastHandler>
    ) => {
      if (transcriptBroadcastMocks.useActualHandler) {
        return actual.createTranscriptUpdateBroadcastHandler(...args);
      }
      return () => {
        throw new Error("transcript handler failure");
      };
    },
    createLifecycleEventBroadcastHandler: () => () => {
      throw new Error("lifecycle handler failure");
    },
  };
});

const { startGatewayEventSubscriptions } = await import("./server-runtime-subscriptions.js");
type SubscriptionParams = Parameters<typeof startGatewayEventSubscriptions>[0];

type LifecycleTransition = { state: string; lifecycle?: ReturnType<typeof readLifecycleState> };

function createParams(): SubscriptionParams {
  const chatRunState = createChatRunState();
  return {
    signal: new AbortController().signal,
    log: mockLog,
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    nodeHasSessionSubscribers: () => false,
    nodeSendToSession: vi.fn(),
    agentRunSeq: new Map(),
    chatRunState,
    toolEventRecipients: chatRunState.toolEventRecipients,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    chatAbortControllers: new Map(),
    restartRecoveryCandidates: new Map(),
    terminalSessions: { closeTaskSessions: vi.fn() },
    refreshConnectedUserProfiles: vi.fn(),
  };
}

describe("startGatewayEventSubscriptions", () => {
  let unsubs: ReturnType<typeof startGatewayEventSubscriptions> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    auditTestState.enabled = true;
    auditTestState.messageMode = "off";
    auditTestState.created = 0;
    auditTestState.recorded = 0;
    auditTestState.identityRecorded = 0;
    auditTestState.decisionRecorded = 0;
    auditTestState.executionIdentityEnabled = false;
    auditTestState.stopped = 0;
    transcriptBroadcastMocks.useActualHandler = false;
    transcriptBroadcastMocks.readMessageById.mockReset();
    runtimeConfigState.value = {};
    agentEventHandlerMocks.persistLifecycle.mockReset().mockResolvedValue(undefined);
    agentEventHandlerMocks.resolveSessionKey.mockClear();
    agentEventHandlerMocks.create.mockReset().mockImplementation(() => {
      throw new Error("server-chat lazy load failure");
    });
    installInMemoryTaskRegistryRuntime();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await unsubs?.agentUnsub();
    unsubs?.heartbeatUnsub();
    unsubs?.transcriptUnsub();
    unsubs?.lifecycleUnsub();
    await unsubs?.taskUnsub();
    resetAgentEventsForTest();
    resetTaskRegistryForTests({ persist: false });
    configureExecutionIdentityAdmissionSink(() => false)();
  });

  registerTaskSubscriptionOwnershipTests(
    (broadcast, terminalSessions = { closeTaskSessions: vi.fn(() => 1) }) => {
      unsubs = startGatewayEventSubscriptions({ ...createParams(), broadcast, terminalSessions });
      return { taskUnsub: unsubs.taskUnsub, closeTaskSessions: terminalSessions.closeTaskSessions };
    },
  );

  it.each([
    "same-id reset",
    "replacement",
    "missing row",
    "missing row without ID",
    "missing projection",
  ])("does not attach a successor row after a queued %s", async (change) => {
    const prepared = createDeferred();
    const original = { sessionId: "original" };
    let current: typeof original | undefined = change.startsWith("missing row")
      ? undefined
      : original;
    let admitted = change !== "missing projection";
    const projection = {
      capture: () => current,
      ensureMaterialized: () => prepared.promise,
      isCurrent: (record: typeof original) => record === current,
      snapshot: () => ({ row: current ? { key: "agent:main:queued", ...current } : null }),
    } as unknown as SessionRowProjection;
    const delivered = vi.fn();
    agentEventHandlerMocks.create.mockImplementation((options: AgentEventHandlerOptions) =>
      Object.assign(
        (event: AgentEventPayload) => {
          delivered(
            options.loadGatewaySessionLifecycleSnapshotForEvent?.("agent:main:queued", {
              agentId: "main",
              ownerEvent: event,
            }).row,
          );
        },
        { dispose: vi.fn() },
      ),
    );
    unsubs = startGatewayEventSubscriptions({
      ...createParams(),
      getSessionRowProjection: () => (admitted ? projection : undefined),
    });
    emitAgentEvent({
      runId: "queued-owner",
      agentId: "main",
      sessionKey: "agent:main:queued",
      sessionId: change === "missing row without ID" ? undefined : "original",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1 },
    });
    current = { sessionId: change === "replacement" ? "successor" : "original" };
    admitted = true;
    prepared.resolve();
    await waitForFast(() => expect(delivered).toHaveBeenCalledWith(null));
  });

  it.each([false, true])(
    "keeps activity-summary publication bound to its captured lifecycle (same-ID reset: %s)",
    async (reset) => {
      const prepared = createDeferred();
      const target = { key: "agent:main:activity", agentId: "main" };
      const original = { sessionId: "same-session", lifecycleRevision: "original" };
      let current = original;
      const projection = {
        capture: () => current,
        ensureMaterialized: () => prepared.promise,
        isCurrent: (record: typeof original) => record === current,
        snapshot: () => ({ row: { key: target.key, ...current } }),
      } as unknown as SessionRowProjection;
      const params = createParams();
      unsubs = startGatewayEventSubscriptions({
        ...params,
        getSessionRowProjection: () => projection,
      });
      const onChanged = observeActivitySummary.mock.calls[0]?.[0].onChanged;
      if (!onChanged) {
        throw new Error("missing activity-summary publication callback");
      }
      onChanged(target);
      expect(params.broadcast).not.toHaveBeenCalled();
      if (reset) {
        current = { ...original, lifecycleRevision: "replacement" };
      }
      prepared.resolve();
      await unsubs.agentUnsub();
      if (reset) {
        expect(params.broadcast).not.toHaveBeenCalled();
      } else {
        expect(params.broadcast).toHaveBeenCalledExactlyOnceWith(
          "sessions.changed",
          expect.objectContaining({
            reason: "activity-summary",
            session: expect.objectContaining({ key: target.key, ...original }),
          }),
          { sessionKeys: [target.key], agentId: target.agentId, dropIfSlow: true },
        );
      }
    },
  );

  it("broadcasts suspension immediately and stops with the gateway lifecycle", () => {
    resetGatewayWorkAdmission();
    const params = createParams();
    unsubs = startGatewayEventSubscriptions(params);
    try {
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      suspension?.drain();
      suspension?.commit();
      suspension?.release();
      expect(vi.mocked(params.broadcast).mock.calls).toEqual([
        ["gateway.suspension", { phase: "preparing" }],
        ["gateway.suspension", { phase: "draining" }],
        ["gateway.suspension", { phase: "prepared" }],
        ["gateway.suspension", { phase: "accepting" }],
      ]);
      unsubs.lifecycleUnsub();
      vi.mocked(params.broadcast).mockClear();
      tryBeginGatewaySuspendAdmission(() => {})?.rollback();
      expect(params.broadcast).not.toHaveBeenCalled();
    } finally {
      resetGatewayWorkAdmission();
    }
  });

  it("records audit events by default and stops the recorder on unsubscribe", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    expect(auditTestState.created).toBe(1);
    emitAgentAuditEvent({
      runId: "enabled-audit",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    expect(auditTestState.recorded).toBe(1);
    expect(hasExecutionIdentityAdmissionSink()).toBe(true);
    expect(
      enqueueExecutionIdentityContextAtAdmission(
        {
          runId: "gateway-admission",
          agentId: "main",
          ingress: { kind: "system", boundary: "gateway.boot", state: "present" },
          runtime: { kind: "embedded" },
        },
        { enabled: true, runtimeInstanceId: "runtime-1" },
      )?.accepted,
    ).toBe(true);
    expect(auditTestState.identityRecorded).toBe(1);
    await unsubs.agentUnsub();
    expect(auditTestState.stopped).toBe(1);
    expect(hasExecutionIdentityAdmissionSink()).toBe(false);
  });

  it("owns channel evidence collection for the configured gateway lifecycle", async () => {
    auditTestState.executionIdentityEnabled = true;
    unsubs = startGatewayEventSubscriptions(createParams());

    const evidence = createChannelParticipantAdmissionEvidence({
      channelId: "test",
      participantId: "person-1",
    });
    expect(evidence).toBeDefined();

    await unsubs.agentUnsub();
    expect(consumeChannelAdmissionEvidence(evidence)).toMatchObject({ ingressState: "unknown" });
    expect(
      createChannelParticipantAdmissionEvidence({
        channelId: "test",
        participantId: "person-2",
      }),
    ).toBeUndefined();
  });

  it("keeps retention maintenance but creates no producers when audit.enabled is false", async () => {
    auditTestState.enabled = false;
    unsubs = startGatewayEventSubscriptions(createParams());

    expect(auditTestState.created).toBe(1);
    emitAgentAuditEvent({
      runId: "disabled-private",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    emitAgentEvent({
      runId: "disabled-public",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    expect(auditTestState.recorded).toBe(0);
    await waitForFast(() => expect(warn).toHaveBeenCalledOnce());
    warn.mockClear();
    // Disabled wiring must still unsubscribe cleanly.
    await unsubs.agentUnsub();
    expect(auditTestState.stopped).toBe(1);
  });

  it("logs lazy agent event handler failures", async () => {
    const runId = "run-claimed-terminal";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const claimId = claimAgentRunContext(
      runId,
      {
        lifecycleGeneration,
        sessionId: "session-1",
      },
      { exclusive: true, ownsContext: true, trackOwner: true },
    );
    if (!claimId) {
      throw new Error("expected terminal event claim");
    }
    agentEventHandlerMocks.persistLifecycle.mockRejectedValue(new Error("terminal write rejected"));
    unsubs = startGatewayEventSubscriptions(createParams());

    emitAgentEventForOwner(
      {
        runId,
        sessionId: "session-1",
        stream: "lifecycle",
        data: { phase: "end", startedAt: 1_000, endedAt: 2_000 },
      },
      claimId,
    );

    await waitForFast(() => expect(warn).toHaveBeenCalledTimes(2));
    expect(agentEventHandlerMocks.persistLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ assertCommitAllowed: expect.any(Function) }),
    );
    expect(agentEventHandlerMocks.resolveSessionKey).toHaveBeenCalledWith(runId, undefined);
    expect(warn).toHaveBeenCalledWith(
      "Agent event dispatch failed",
      expect.objectContaining({ runId, stream: "lifecycle" }),
    );
    expect(warn).toHaveBeenCalledWith(
      "Terminal session persistence failed",
      expect.objectContaining({ runId }),
    );
    expect(ownerStatus(runId, claimId, lifecycleGeneration)).toBe("clear-requested");
    releaseAgentRunContext(runId, claimId);
  });

  it("disposes a loaded agent event handler on unsubscribe", async () => {
    const dispose = vi.fn();
    const handler = Object.assign(vi.fn(), { dispose });
    agentEventHandlerMocks.create.mockReturnValue(handler);
    unsubs = startGatewayEventSubscriptions(createParams());

    emitAgentEvent({ runId: "run-dispose", stream: "lifecycle", data: { phase: "error" } });
    await waitForFast(() => expect(handler).toHaveBeenCalledOnce());

    await unsubs.agentUnsub();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("uses the persisted bare-key owner for ownerless active-run projections", async () => {
    runtimeConfigState.value = {
      session: { scope: "global", store: "/tmp/openclaw-owned-sessions.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };
    const handler = Object.assign(vi.fn(), { dispose: vi.fn() });
    agentEventHandlerMocks.create.mockReturnValue(handler);
    const params = createParams();
    params.chatAbortControllers.set("run-ops", {
      sessionKey: "global",
      sessionId: "session-ops",
    } as never);
    unsubs = startGatewayEventSubscriptions(params);

    emitAgentEvent({ runId: "load-handler", stream: "lifecycle", data: { phase: "error" } });
    await waitForFast(() => expect(agentEventHandlerMocks.create).toHaveBeenCalledOnce());
    const options = agentEventHandlerMocks.create.mock.calls[0]?.[0] as {
      resolveSessionActiveRunState?: (session: {
        requestedKey: string;
        canonicalKey: string;
        sessionId?: string;
        agentId?: string;
      }) => { active: boolean; runIds: string[] };
    };

    expect(
      options.resolveSessionActiveRunState?.({
        requestedKey: "global",
        canonicalKey: "global",
        sessionId: "session-ops",
        agentId: "ops",
      }),
    ).toEqual({ active: true, runIds: ["run-ops"] });
  });

  it("drives a registered chat run through the terminal persistence transition table", async () => {
    const runId = "run-lifecycle-table";
    const sessionKey = "agent:main:main";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const params = createParams();
    const registration = registerChatAbortController({
      chatAbortControllers: params.chatAbortControllers,
      runId,
      sessionId: "session-lifecycle-table",
      sessionKey,
      timeoutMs: 60_000,
      lifecycleGeneration,
    });
    if (!registration.entry) {
      throw new Error("expected registered chat abort controller");
    }
    const entry = registration.entry;
    const transitions: LifecycleTransition[] = [
      { state: "Registered", lifecycle: readLifecycleState(entry) },
    ];
    agentEventHandlerMocks.create.mockReturnValue(Object.assign(vi.fn(), { dispose: vi.fn() }));
    unsubs = startGatewayEventSubscriptions(params);

    emitAgentEvent({
      runId,
      lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    transitions.push({ state: "Start-normalized", lifecycle: readLifecycleState(entry) });
    await waitForFast(() => expect(agentEventHandlerMocks.create).toHaveBeenCalledOnce());

    emitAgentEvent({
      runId,
      lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "error", error: "retryable provider failure", endedAt: 2_000 },
    });
    emitAgentEvent({
      runId,
      lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 2_500 },
    });
    expect(agentEventHandlerMocks.persistLifecycle).not.toHaveBeenCalled();

    const terminalPersistence = createDeferred();
    agentEventHandlerMocks.persistLifecycle.mockReturnValue(terminalPersistence.promise);

    emitAgentEvent({
      runId,
      lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "end", endedAt: 3_000 },
    });
    transitions.push({ state: "Persisting", lifecycle: readLifecycleState(entry) });

    terminalPersistence.resolve();
    await waitForFast(() => expect(entry.projectSessionTerminalPersisted).toBe(true));
    transitions.push({ state: "Persisted", lifecycle: readLifecycleState(entry) });

    registration.cleanup();
    transitions.push({ state: "Removed" });
    expect(params.chatAbortControllers.has(runId)).toBe(false);
    expect(transitions).toEqual([
      { state: "Registered", lifecycle: lifecycleState(true) },
      { state: "Start-normalized", lifecycle: lifecycleState(true, false) },
      {
        state: "Persisting",
        lifecycle: lifecycleState(false, true, 3_000, terminalPersistence.promise, false),
      },
      { state: "Persisted", lifecycle: lifecycleState(false, false, 3_000, undefined, true) },
      { state: "Removed" },
    ]);
  });

  it.each(["start", "end"] as const)(
    "generation-fences a current lifecycle %s event from a retired registration",
    async (phase) => {
      const runId = `run-retired-${phase}`;
      const currentLifecycleGeneration = getAgentEventLifecycleGeneration();
      const params = createParams();
      const registration = registerChatAbortController({
        chatAbortControllers: params.chatAbortControllers,
        runId,
        sessionId: `session-retired-${phase}`,
        sessionKey: "agent:main:main",
        timeoutMs: 60_000,
        lifecycleGeneration: `${currentLifecycleGeneration}-retired`,
      });
      if (!registration.entry) {
        throw new Error("expected registered chat abort controller");
      }
      const registered = readLifecycleState(registration.entry);
      agentEventHandlerMocks.create.mockReturnValue(Object.assign(vi.fn(), { dispose: vi.fn() }));
      unsubs = startGatewayEventSubscriptions(params);

      emitAgentEvent({
        runId,
        lifecycleGeneration: currentLifecycleGeneration,
        stream: "lifecycle",
        data: phase === "start" ? { phase, startedAt: 1_000 } : { phase, endedAt: 1_000 },
      });

      expect(readLifecycleState(registration.entry)).toEqual(registered);
      await waitForFast(() => expect(agentEventHandlerMocks.create).toHaveBeenCalledOnce());
    },
  );

  it("bridges abort cleanup until terminal persistence is attached and settled", async () => {
    const runId = "run-abort-persistence-bridge";
    const sessionKey = "agent:main:main";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const params = createParams();
    const registration = registerChatAbortController({
      chatAbortControllers: params.chatAbortControllers,
      runId,
      sessionId: "session-abort-persistence-bridge",
      sessionKey,
      timeoutMs: 60_000,
      lifecycleGeneration,
    });
    if (!registration.entry) {
      throw new Error("expected registered chat abort controller");
    }
    const entry = registration.entry;
    agentEventHandlerMocks.create.mockReturnValue(Object.assign(vi.fn(), { dispose: vi.fn() }));
    unsubs = startGatewayEventSubscriptions(params);
    emitAgentEvent({
      runId,
      lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    await waitForFast(() => expect(agentEventHandlerMocks.create).toHaveBeenCalledOnce());
    const terminalPersistence = createDeferred();
    agentEventHandlerMocks.persistLifecycle.mockReturnValue(terminalPersistence.promise);

    expect(
      abortChatRunById(
        {
          chatAbortControllers: params.chatAbortControllers,
          chatRunState: params.chatRunState,
          removeChatRun: vi.fn(() => undefined),
          agentRunSeq: params.agentRunSeq,
          broadcast: vi.fn(),
          nodeSendToSession: vi.fn(),
        },
        { runId, sessionKey, stopReason: "user" },
      ),
    ).toEqual({ aborted: true });
    expect(params.chatAbortControllers.get(runId)).toBe(entry);
    expect(readLifecycleState(entry)).toMatchObject({
      projectSessionActive: false,
      projectSessionTerminalPending: true,
      projectSessionTerminalObservedAt: expect.any(Number),
      registrationCleanupRequested: true,
    });

    await Promise.resolve();
    expect(params.chatAbortControllers.get(runId)).toBe(entry);
    expect(readLifecycleState(entry)).toMatchObject({
      projectSessionActive: false,
      projectSessionTerminalPending: true,
      projectSessionTerminalPersistence: terminalPersistence.promise,
      projectSessionTerminalPersisted: false,
      registrationCleanupRequested: true,
    });

    terminalPersistence.resolve();
    await waitForFast(() => expect(params.chatAbortControllers.has(runId)).toBe(false));
  });

  it("logs transcript handler failures", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    emitSessionTranscriptUpdate({
      sessionFile: "/tmp/sess.jsonl",
      sessionKey: "agent:main:main",
    } as InternalSessionTranscriptUpdate);

    await waitForFast(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      "Transcript update dispatch failed",
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
  });

  it("logs real asynchronous transcript failures and recovers the broadcast queue", async () => {
    transcriptBroadcastMocks.useActualHandler = true;
    const failedRead = createDeferred();
    const persistenceFailure = new Error("session transcript read failed");
    const transcriptPosition = { source: "recovered-generation", rawSeq: 7 };
    const storedMessage = {
      role: "assistant",
      content: [{ type: "text", text: "visible answer" }],
      __openclaw: { transcriptPosition },
    };
    transcriptBroadcastMocks.readMessageById
      .mockImplementationOnce(async () => {
        await failedRead.promise;
        throw persistenceFailure;
      })
      .mockResolvedValueOnce({ found: true, oversized: false, seq: 2, message: storedMessage });

    const params = createParams();
    params.sessionEventSubscribers.subscribe("conn-transcript");
    unsubs = startGatewayEventSubscriptions(params);

    const emitMessage = (messageId: string) =>
      emitSessionTranscriptUpdate({
        sessionFile: "/tmp/openclaw-transcript-dispatch.sqlite",
        sessionKey: "agent:main:main",
        message: { role: "assistant", content: [{ type: "text", text: "stale queued answer" }] },
        messageId,
        target: {
          agentId: "main",
          sessionId: "sess-transcript",
          sessionKey: "agent:main:main",
          storePath: "/tmp/openclaw-transcript-dispatch-sessions.json",
        },
      });

    const admission = tryBeginGatewayRootWorkAdmission("test:transcript-publisher");
    if (!admission) {
      throw new Error("Transcript publisher admission was closed");
    }
    await admission.run(async () => emitMessage("failed-message"));
    admission.release();
    await waitForFast(() =>
      expect(transcriptBroadcastMocks.readMessageById).toHaveBeenCalledOnce(),
    );
    try {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    } finally {
      failedRead.resolve();
    }
    await waitForFast(() =>
      expect(warn).toHaveBeenCalledWith("Transcript update dispatch failed", {
        sessionKey: "agent:main:main",
        error: persistenceFailure,
      }),
    );
    expect(params.broadcastToConnIds).not.toHaveBeenCalled();

    emitMessage("recovered-message");
    await waitForFast(() => expect(params.broadcastToConnIds).toHaveBeenCalledOnce());
    expect(params.broadcastToConnIds).toHaveBeenCalledWith(
      "session.message",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        messageId: "recovered-message",
        messageSeq: 2,
        message: expect.objectContaining({
          content: storedMessage.content,
          __openclaw: expect.objectContaining({ transcriptPosition }),
        }),
      }),
      new Set(["conn-transcript"]),
    );
    expect(transcriptBroadcastMocks.readMessageById).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("broadcasts progress-card retirement without session-list subscribers", () => {
    const params = createParams();
    unsubs = startGatewayEventSubscriptions(params);
    emitSessionLifecycleEvent({
      sessionKey: "global",
      agentId: "work",
      reason: "progress-card-reset",
    });
    expect(params.broadcast).toHaveBeenCalledWith(
      "progressCard.changed",
      { sessionKey: "agent:work:global", revision: null },
      { sessionKeys: ["global"], agentId: "work" },
    );
  });

  it("logs lifecycle handler failures", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    emitSessionLifecycleEvent({ sessionKey: "agent:main:main", reason: "created" });

    await waitForFast(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      "Lifecycle event dispatch failed",
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
  });

  registerTaskEventSubscriptionTests((overrides) => {
    unsubs = startGatewayEventSubscriptions({ ...createParams(), ...overrides });
    return unsubs;
  }, mockLog);
});
