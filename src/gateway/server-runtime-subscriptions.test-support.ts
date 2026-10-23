import { randomUUID } from "node:crypto";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  bindTestChannelParticipantAdmissionEvidence,
  createChannelParticipantAdmissionEvidence,
} from "../../test/helpers/channel-admission-evidence.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  enqueueExecutionIdentityContextAtAdmission,
  hasExecutionIdentityAdmissionSink,
} from "../audit/execution-identity-admission.js";
import { emitTrustedMessageAuditEvent } from "../audit/message-audit-events.js";
import {
  consumeChannelAdmissionEvidence,
  readChannelContextGatewayContextResolver,
  recordChannelAdmissionDecision,
} from "../channels/message-access/admission-evidence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  type AgentEventPayload,
  emitAgentAuditEvent,
  emitAgentEvent,
  emitAgentEventForOwner,
  getAgentEventLifecycleGeneration,
  onAgentRuntimeEvent,
} from "../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { heartbeatNotifications } from "../infra/heartbeat-events.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import {
  releaseSessionControllerClaim,
  retireSessionControllerInput,
} from "../sessions/session-controller.mailbox.js";
import type { RpcSourceRef } from "../sessions/session-controller.rpc-sources.js";
import {
  getRpcSource,
  getRpcSourceProjectSessionActive,
} from "../sessions/session-controller.rpc-sources.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { waitForChatAbortTerminalPersistence } from "./chat-abort-lifecycle-internal.js";
import { registerChatAbortController } from "./chat-abort.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { prepareGatewayRunShutdown } from "./server-run-shutdown.js";
import type { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";

export function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

export function createSubscriptionTestFixture() {
  const warn = vi.fn();
  const log: SubsystemLogger = {
    subsystem: "gateway-test",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: () => log,
  };
  return {
    log,
    warn,
    createParams: (): Parameters<typeof startGatewayEventSubscriptions>[0] => {
      const chatRunState = createChatRunState();
      return {
        scheduler: createTestGatewayScheduler(),
        signal: new AbortController().signal,
        log,
        broadcast: vi.fn(),
        broadcastToConnIds: vi.fn(),
        nodeHasSessionSubscribers: () => false,
        nodeSendToSession: vi.fn(),
        agentRunSeq: new Map(),
        chatRunState,
        toolEventRecipients: chatRunState.toolEventRecipients,
        sessionEventSubscribers: createSessionEventSubscriberRegistry(),
        sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
        restartRecoveryCandidates: new Map(),
        refreshConnectedUserProfiles: vi.fn(),
      };
    },
  };
}

export function registerSubscriptionChatRun(
  _params: Parameters<typeof startGatewayEventSubscriptions>[0],
  input: Omit<Parameters<typeof registerChatAbortController>[0], "timeoutMs">,
) {
  const registration = registerChatAbortController({
    ...input,
    target:
      input.target ??
      captureSessionTarget({
        storeScope: `/synthetic/subscription/${randomUUID()}/sessions`,
        sessionKey: input.sessionKey ?? "agent:main:subscription",
        agentId: input.agentId,
        incarnation: input.sessionId,
      }),
    timeoutMs: 60_000,
  });
  if (!registration.entry) {
    throw new Error("expected registered chat abort controller");
  }
  registration.initializeTiming();
  const entry = registration.entry;
  onTestFinished(async () => {
    const claim = entry.input.claim;
    claim?.operation?.complete();
    if (claim) {
      releaseSessionControllerClaim(claim);
      await Promise.allSettled([claim.settlement.promise]);
    }
    registration.cleanup();
    retireSessionControllerInput(entry.input);
    await Promise.allSettled([entry.input.settlement.promise]);
  });
  return { ...registration, entry };
}

export function readLifecycleState(entry: RpcSourceRef) {
  return {
    projectSessionActive: getRpcSourceProjectSessionActive(entry),
    projectSessionTerminalPending: entry.adapter.projectSessionTerminalPending,
    projectSessionTerminalObservedAt: entry.adapter.projectSessionTerminalObservedAt,
    projectSessionTerminalPersistence: entry.adapter.projectSessionTerminalPersistence,
    projectSessionTerminalPersisted: entry.adapter.projectSessionTerminalPersisted,
    retirementRequested: entry.input.retirementRequested,
  };
}

export function lifecycleState(
  projectSessionActive: boolean | undefined,
  projectSessionTerminalPending?: boolean,
  projectSessionTerminalObservedAt?: number,
  projectSessionTerminalPersistence?: Promise<void>,
  projectSessionTerminalPersisted?: boolean,
  retirementRequested?: boolean,
): ReturnType<typeof readLifecycleState> {
  return {
    projectSessionActive,
    projectSessionTerminalPending,
    projectSessionTerminalObservedAt,
    projectSessionTerminalPersistence,
    projectSessionTerminalPersisted,
    retirementRequested,
  };
}

export function registerAuditSubscriptionTests(params: {
  start: () => ReturnType<typeof startGatewayEventSubscriptions>;
  runtimeConfigState: { value: OpenClawConfig };
  auditTestState: {
    created: number;
    recorded: number;
    messages: number;
    identityRecorded: number;
    decisionRecorded: number;
    stopped: number;
  };
  warn: ReturnType<typeof createSubscriptionTestFixture>["warn"];
}) {
  const { start, runtimeConfigState, auditTestState, warn } = params;
  it("records audit events by default and stops the recorder on unsubscribe", async () => {
    runtimeConfigState.value = { logging: { audit: { executionIdentity: true } } };
    const unsubs = start();

    expect(auditTestState.created).toBe(1);
    emitAgentAuditEvent({
      runId: "enabled-audit",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    expect(auditTestState.recorded).toBe(0);
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
    expect(auditTestState.recorded).toBe(1);
    expect(auditTestState.stopped).toBe(1);
    expect(hasExecutionIdentityAdmissionSink()).toBe(false);
  });

  it("owns channel evidence collection without retiring host routing on audit changes", async () => {
    const unsubs = start();
    const participant = { channelId: "test", participantId: "person-1" };
    const evidenceFor = (subscription = unsubs) =>
      createChannelParticipantAdmissionEvidence({
        audit: subscription.channelAdmissionAudit,
        ...participant,
      });
    const setPolicy = (enabled: boolean) => {
      runtimeConfigState.value = { logging: { audit: { enabled, executionIdentity: true } } };
      unsubs.reconcileAuditPolicy(runtimeConfigState.value);
    };
    const context = {};
    expect(
      bindTestChannelParticipantAdmissionEvidence({
        audit: unsubs.channelAdmissionAudit,
        context,
        ...participant,
      }),
    ).toBeUndefined();
    const resolveGateway = readChannelContextGatewayContextResolver(context);
    expect(resolveGateway).toBeTypeOf("function");
    const gateway = resolveGateway?.();
    expect(gateway?.channelAdmissionAudit).toBe(unsubs.channelAdmissionAudit);

    setPolicy(true);
    const evidence = evidenceFor();
    expect(evidence).toBeDefined();
    unsubs.reconcileAuditPolicy(runtimeConfigState.value);
    expect(consumeChannelAdmissionEvidence(evidence)).toMatchObject({ ingressState: "present" });
    const decision = {
      contextId: "audit-toggle-context",
      executionId: "audit-toggle-execution",
      runId: "audit-toggle-run",
      occurredAt: 1_000,
      coverageState: "attribution-only" as const,
      identifierAuthentication: "not-evaluated" as const,
    };
    expect(recordChannelAdmissionDecision(evidence, decision)).toBe(true);
    expect(auditTestState.decisionRecorded).toBe(1);

    const retired = evidenceFor();
    expect(retired).toBeDefined();
    setPolicy(false);
    const disabledContext = {};
    expect(
      bindTestChannelParticipantAdmissionEvidence({
        audit: unsubs.channelAdmissionAudit,
        context: disabledContext,
        ...participant,
      }),
    ).toBeUndefined();
    expect(readChannelContextGatewayContextResolver(context)).toBe(resolveGateway);
    expect(resolveGateway?.()).toBe(gateway);
    expect(
      readChannelContextGatewayContextResolver(disabledContext)?.()?.channelAdmissionAudit,
    ).toBe(unsubs.channelAdmissionAudit);

    setPolicy(true);
    expect(consumeChannelAdmissionEvidence(retired)).toMatchObject({ ingressState: "unknown" });
    expect(recordChannelAdmissionDecision(evidence, decision)).toBe(false);
    expect(auditTestState.decisionRecorded).toBe(1);
    expect(readChannelContextGatewayContextResolver(context)).toBe(resolveGateway);
    expect(resolveGateway?.()).toBe(gateway);

    const beforeShutdown = evidenceFor();
    expect(beforeShutdown).toBeDefined();
    await unsubs.agentUnsub();
    unsubs.reconcileAuditPolicy({ logging: { audit: { enabled: false } } });
    unsubs.reconcileAuditPolicy(runtimeConfigState.value);
    expect(consumeChannelAdmissionEvidence(beforeShutdown)).toMatchObject({
      ingressState: "unknown",
    });
    expect(evidenceFor()).toBeUndefined();

    heartbeatNotifications.onEvent = () => {};
    unsubs.transcriptUnsub();
    unsubs.lifecycleUnsub();
    const restarted = start();
    expect(consumeChannelAdmissionEvidence(evidenceFor(restarted))).toMatchObject({
      ingressState: "present",
      invoker: { state: "present" },
    });
    expect(consumeChannelAdmissionEvidence(beforeShutdown)).toMatchObject({
      ingressState: "unknown",
    });
  });

  it("applies audit policy changes through the existing event subscriptions", async () => {
    runtimeConfigState.value = { logging: { audit: { enabled: false } } };
    const unsubs = start();
    const disabled = { enabled: false, messages: "all", executionIdentity: true } as const;
    const steps: Array<
      [NonNullable<NonNullable<OpenClawConfig["logging"]>["audit"]>, number, number, number]
    > = [
      [disabled, 0, 0, 0],
      [{}, 2, 0, 0],
      [{ messages: "direct", executionIdentity: true }, 4, 1, 1],
      [{ messages: "all" }, 6, 3, 1],
      [disabled, 6, 3, 1],
    ];
    for (const [index, [audit, recorded, messages, identityRecorded]] of steps.entries()) {
      runtimeConfigState.value = { logging: { audit } };
      unsubs.reconcileAuditPolicy(runtimeConfigState.value);
      const runId = `live-audit-${index}`;
      emitAgentAuditEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
      emitAgentAuditEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "end", startedAt: 1_000, endedAt: 2_000 },
      });
      for (const conversationKind of ["direct", "group"] as const) {
        emitTrustedMessageAuditEvent({
          occurredAt: 1_000,
          kind: "message",
          action: "message.inbound.processed",
          status: "succeeded",
          actorType: "channel_sender",
          actorId: "synthetic-sender",
          direction: "inbound",
          channel: "test",
          conversationKind,
          outcome: "completed",
        });
      }
      enqueueExecutionIdentityContextAtAdmission(
        {
          runId,
          agentId: "main",
          ingress: { kind: "system", boundary: "test" },
          runtime: { kind: "gateway" },
        },
        { enabled: true },
      );
      expect(auditTestState).toMatchObject({
        created: 1,
        stopped: 0,
        recorded,
        messages,
        identityRecorded,
      });
    }
    await unsubs.agentUnsub();
    expect(auditTestState.stopped).toBe(1);
  });

  it("keeps retention maintenance and applies audit enablement to subsequent events", async () => {
    runtimeConfigState.value = { logging: { audit: { enabled: false } } };
    const unsubs = start();

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
    runtimeConfigState.value = {};
    emitAgentAuditEvent({
      runId: "resumed-private",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 2_000 },
    });
    expect(auditTestState.recorded).toBe(0);
    runtimeConfigState.value = { logging: { audit: { enabled: false } } };
    emitAgentAuditEvent({
      runId: "disabled-again",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 3_000 },
    });
    expect(auditTestState.recorded).toBe(1);
    await waitForFast(() => expect(warn).toHaveBeenCalledOnce());
    warn.mockClear();
    await unsubs.agentUnsub();
    expect(auditTestState.stopped).toBe(1);
  });
}

export function registerSubscriptionRegistrationTests(
  start: typeof startGatewayEventSubscriptions,
  prepareTerminalWrite: (terminal: Promise<void>) => void,
) {
  const { createParams } = createSubscriptionTestFixture();
  it.each(["fulfilled", "rejected"] as const)(
    "joins the subscription-owned terminal write during registration cleanup and restart (%s)",
    async (outcome) => {
      const params = createParams();
      const runId = "terminal-cleanup-restart";
      const sessionKey = "agent:main:main";
      const sessionId = "terminal-cleanup-session";
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const resolveGatewayContext = () => undefined;
      const registration = registerSubscriptionChatRun(params, {
        runId,
        sessionId,
        sessionKey,
        lifecycleGeneration,
      });
      bindGatewayContextResolver(registration.entry.input, resolveGatewayContext);
      const terminal = createDeferred();
      const failure = new Error("terminal write failed");
      prepareTerminalWrite(terminal.promise);
      const unsubs = start({ ...params, resolveGatewayContext });
      const marker =
        vi.fn<
          NonNullable<
            Parameters<typeof prepareGatewayRunShutdown>[0]["markMainSessionsAbortedForRestart"]
          >
        >();
      try {
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          sessionKey,
          sessionId,
          lifecycleGeneration,
          data: { phase: "end", endedAt: Date.now() },
        });
        const persistence = registration.entry.adapter.projectSessionTerminalPersistence;
        expect(persistence).toBeInstanceOf(Promise);
        registration.cleanup();
        expect(getRpcSource(runId)).toBe(registration.entry);
        const shutdown = prepareGatewayRunShutdown({
          ...params,
          resolveGatewayContext,
          removeChatRun: (chatSessionId, clientRunId, key) =>
            params.chatRunState.registry.remove(chatSessionId, clientRunId, key),
          getPendingReplyCount: () => 0,
          timeoutMs: 0,
          warnings: [],
          markMainSessionsAbortedForRestart: marker,
        });
        expect(marker).not.toHaveBeenCalled();
        if (outcome === "fulfilled") {
          terminal.resolve();
        } else {
          terminal.reject(failure);
        }
        const { released } = await shutdown;
        if (outcome === "fulfilled") {
          await released;
        } else {
          // The terminal owner below asserts failure; shutdown still joins physical settlement.
          await Promise.allSettled([released]);
        }
        await unsubs.agentUnsub();
        expect(getRpcSource(runId)).toBeUndefined();
        expect(registration.entry.adapter.projectSessionTerminalPersisted).toBe(
          outcome === "fulfilled",
        );
        expect(marker).toHaveBeenCalledOnce();
        const recovery = marker.mock.calls[0]?.[0];
        expect(recovery?.activeRuns.filter(recovery.isActiveRun)).toEqual(
          outcome === "fulfilled"
            ? []
            : [
                expect.objectContaining({
                  runId,
                  sessionKey,
                  sessionId,
                }),
              ],
        );
        if (outcome === "rejected") {
          await expect(waitForChatAbortTerminalPersistence(registration.entry)).rejects.toBe(
            failure,
          );
        }
      } finally {
        terminal.resolve();
        await unsubs.agentUnsub();
        registration.cleanup();
      }
    },
  );

  it("does not mark a reentrant replacement terminal from the previous claim", () => {
    const params = createParams();
    const runId = "replaced-terminal-claim";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const identity = {
      sessionKey: "agent:main:replaced",
      sessionId: "replaced-session",
      lifecycleGeneration,
    };
    let registration = registerSubscriptionChatRun(params, { runId, ...identity });
    const ownership = { exclusive: true, ownsContext: true, trackOwner: true };
    const originalClaim = claimAgentRunContext(runId, identity, ownership);
    if (!originalClaim) {
      throw new Error("Missing original claim");
    }
    let replacementClaim: string | undefined;
    const removeListener = onAgentRuntimeEvent((event) => {
      if (event.runId !== runId) {
        return;
      }
      releaseAgentRunContext(runId, originalClaim);
      registration.cleanup();
      registration = registerSubscriptionChatRun(params, { runId, ...identity });
      replacementClaim = claimAgentRunContext(runId, identity, ownership);
    });
    start(params);
    try {
      emitAgentEventForOwner({ runId, stream: "lifecycle", data: { phase: "end" } }, originalClaim);
      expect(replacementClaim).toBeTruthy();
      expect(registration.entry.adapter.terminalOutcomeObserved).toBeUndefined();
      expect(readLifecycleState(registration.entry)).toEqual(lifecycleState(undefined));
    } finally {
      removeListener();
      registration.cleanup();
      releaseAgentRunContext(runId, replacementClaim ?? originalClaim);
    }
  });

  it("does not attach a missing-key terminal to a registration created during deferred preparation", async () => {
    const params = createParams();
    const runId = "late-terminal-registration";
    const unsubs = start(params);
    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
    const registration = registerSubscriptionChatRun(params, {
      runId,
      sessionKey: "agent:main:main",
      sessionId: "late-terminal-session",
    });
    try {
      await unsubs.agentUnsub();
      expect(readLifecycleState(registration.entry)).toEqual(lifecycleState(undefined));
      expect(registration.entry.adapter.terminalOutcomeObserved).toBeUndefined();
    } finally {
      registration.cleanup();
    }
  });
}

export function registerAssistantTailSubscriptionTests({
  createParams,
  installHandlerFactory,
  start,
}: {
  createParams: ReturnType<typeof createSubscriptionTestFixture>["createParams"];
  installHandlerFactory: (
    factory: typeof import("./server-chat.js").createAgentEventHandler,
  ) => void;
  start: (params: Parameters<typeof startGatewayEventSubscriptions>[0]) => void;
}): void {
  it.each([
    { source: "plain", committed: ["Saved paragraph."], initial: "Saved paragraph." },
    {
      source: "native raw directive",
      committed: ["[[reply_to_current]]Saved paragraph."],
      initial: "[[reply_to_current]]Saved paragraph.",
    },
    {
      source: "native partial before directive",
      committed: ["Saved[[reply_to_current]] paragraph."],
      initial: "Saved",
    },
    { source: "before first bytes", committed: ["Saved paragraph."], initial: undefined },
    {
      source: "identical receipts before first bytes",
      committed: ["Saved paragraph.", "Saved paragraph."],
      initial: undefined,
    },
  ])(
    "retires $source by identity before queued continuation without session subscribers",
    async ({ committed, initial }) => {
      const actual = await vi.importActual<typeof import("./server-chat.js")>("./server-chat.js");
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const params = createParams();
      const runId = "run-persisted-tail";
      const sessionKey = "agent:main:main";
      const sessionId = "session-persisted-tail";
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const registration = registerSubscriptionChatRun(params, {
        runId,
        sessionId,
        sessionKey,
        lifecycleGeneration,
      });
      claimAgentRunContext(runId, { lifecycleGeneration, sessionId, sessionKey });
      const delivered = createDeferred();
      installHandlerFactory((options) => {
        const handler = actual.createAgentEventHandler(options);
        return Object.assign(async (event: AgentEventPayload) => {
          await handler(event);
          if (
            typeof event.data.text === "string" &&
            event.data.text.endsWith("Unpersisted tail.")
          ) {
            delivered.resolve();
          }
        }, handler);
      });
      try {
        start(params);
        emitAgentEvent(
          initial === undefined
            ? { runId, stream: "lifecycle", data: { phase: "start", startedAt: Date.now() } }
            : {
                runId,
                stream: "assistant",
                data: { itemId: "saved-paragraph-0", text: initial, delta: initial },
              },
        );
        for (const [index, text] of committed.entries()) {
          emitSessionTranscriptUpdate({
            sessionKey,
            target: { agentId: "main", sessionId, sessionKey },
            messageId: `saved-paragraph-${index}`,
            messageSeq: index * 2 + 2,
            message: {
              role: "assistant",
              idempotencyKey: `saved-paragraph-${index}`,
              content: [{ type: "text", text }],
              __openclaw: { runId },
            },
          });
        }
        for (const [index, text] of committed.entries()) {
          emitAgentEvent({
            runId,
            stream: "assistant",
            data: { itemId: `saved-paragraph-${index}`, text },
          });
        }
        emitAgentEvent({
          runId,
          stream: "assistant",
          data: { itemId: "new-paragraph", text: "Unpersisted tail." },
        });
        await delivered.promise;
        expect(params.chatRunState.resolveBuffer(runId).text.trim()).toBe("Unpersisted tail.");
        expect(params.chatRunState.resolveBuffer(runId, { final: true }).text).toBe(
          `${"Saved paragraph.\n\n".repeat(committed.length)}Unpersisted tail.`,
        );
      } finally {
        params.chatRunState.clear();
        registration.cleanup();
      }
    },
  );
}
