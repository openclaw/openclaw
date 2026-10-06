import { expect, it, vi } from "vitest";
import {
  bindTestChannelParticipantAdmissionEvidence,
  createChannelParticipantAdmissionEvidence,
} from "../../test/helpers/channel-admission-evidence.js";
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
import { emitAgentAuditEvent, emitAgentEvent } from "../infra/agent-events.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { registerChatAbortController, type ChatAbortControllerEntry } from "./chat-abort.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import type { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";

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
        chatAbortControllers: new Map(),
        restartRecoveryCandidates: new Map(),
        refreshConnectedUserProfiles: vi.fn(),
      };
    },
  };
}

export function registerSubscriptionChatRun(
  params: Parameters<typeof startGatewayEventSubscriptions>[0],
  input: Omit<
    Parameters<typeof registerChatAbortController>[0],
    "chatAbortControllers" | "timeoutMs"
  >,
) {
  const registration = registerChatAbortController({
    ...input,
    chatAbortControllers: params.chatAbortControllers,
    timeoutMs: 60_000,
  });
  if (!registration.entry) {
    throw new Error("expected registered chat abort controller");
  }
  return { ...registration, entry: registration.entry };
}

export function readLifecycleState(entry: ChatAbortControllerEntry) {
  return {
    projectSessionActive: entry.projectSessionActive,
    projectSessionTerminalPending: entry.projectSessionTerminalPending,
    projectSessionTerminalObservedAt: entry.projectSessionTerminalObservedAt,
    projectSessionTerminalPersistence: entry.projectSessionTerminalPersistence,
    projectSessionTerminalPersisted: entry.projectSessionTerminalPersisted,
    registrationCleanupRequested: entry.registrationCleanupRequested,
  };
}

export function lifecycleState(
  projectSessionActive: boolean | undefined,
  projectSessionTerminalPending?: boolean,
  projectSessionTerminalObservedAt?: number,
  projectSessionTerminalPersistence?: Promise<void>,
  projectSessionTerminalPersisted?: boolean,
  registrationCleanupRequested?: boolean,
): ReturnType<typeof readLifecycleState> {
  return {
    projectSessionActive,
    projectSessionTerminalPending,
    projectSessionTerminalObservedAt,
    projectSessionTerminalPersistence,
    projectSessionTerminalPersisted,
    registrationCleanupRequested,
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

  it("owns channel evidence collection without retiring host routing on audit changes", async () => {
    const unsubs = start();
    const participant = { channelId: "test", participantId: "person-1" };
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

    runtimeConfigState.value = { logging: { audit: { executionIdentity: true } } };
    unsubs.reconcileAuditPolicy(runtimeConfigState.value);
    const evidence = createChannelParticipantAdmissionEvidence({
      audit: unsubs.channelAdmissionAudit,
      ...participant,
    });
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

    const retired = createChannelParticipantAdmissionEvidence({
      audit: unsubs.channelAdmissionAudit,
      ...participant,
    });
    expect(retired).toBeDefined();
    runtimeConfigState.value = { logging: { audit: { enabled: false, executionIdentity: true } } };
    unsubs.reconcileAuditPolicy(runtimeConfigState.value);
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

    runtimeConfigState.value = { logging: { audit: { executionIdentity: true } } };
    unsubs.reconcileAuditPolicy(runtimeConfigState.value);
    expect(consumeChannelAdmissionEvidence(retired)).toMatchObject({ ingressState: "unknown" });
    expect(recordChannelAdmissionDecision(evidence, decision)).toBe(false);
    expect(auditTestState.decisionRecorded).toBe(1);
    expect(readChannelContextGatewayContextResolver(context)).toBe(resolveGateway);
    expect(resolveGateway?.()).toBe(gateway);

    const beforeShutdown = createChannelParticipantAdmissionEvidence({
      audit: unsubs.channelAdmissionAudit,
      ...participant,
    });
    expect(beforeShutdown).toBeDefined();
    await unsubs.agentUnsub();
    unsubs.reconcileAuditPolicy({ logging: { audit: { enabled: false } } });
    unsubs.reconcileAuditPolicy(runtimeConfigState.value);
    expect(consumeChannelAdmissionEvidence(beforeShutdown)).toMatchObject({
      ingressState: "unknown",
    });
    expect(
      createChannelParticipantAdmissionEvidence({
        audit: unsubs.channelAdmissionAudit,
        ...participant,
      }),
    ).toBeUndefined();

    unsubs.heartbeatUnsub();
    unsubs.transcriptUnsub();
    unsubs.lifecycleUnsub();
    const restarted = start();
    expect(
      consumeChannelAdmissionEvidence(
        createChannelParticipantAdmissionEvidence({
          audit: restarted.channelAdmissionAudit,
          ...participant,
        }),
      ),
    ).toMatchObject({ ingressState: "present", invoker: { state: "present" } });
    expect(consumeChannelAdmissionEvidence(beforeShutdown)).toMatchObject({
      ingressState: "unknown",
    });
  });

  it("applies audit policy changes through the existing event subscriptions", async () => {
    runtimeConfigState.value = { logging: { audit: { enabled: false } } };
    const unsubs = start();
    const steps: Array<{
      audit: NonNullable<NonNullable<OpenClawConfig["logging"]>["audit"]>;
      events: number;
      messages: number;
      identities: number;
    }> = [
      {
        audit: { enabled: false, messages: "all", executionIdentity: true },
        events: 0,
        messages: 0,
        identities: 0,
      },
      { audit: {}, events: 1, messages: 0, identities: 0 },
      {
        audit: { messages: "direct", executionIdentity: true },
        events: 2,
        messages: 1,
        identities: 1,
      },
      { audit: { messages: "all" }, events: 3, messages: 3, identities: 1 },
      {
        audit: { enabled: false, messages: "all", executionIdentity: true },
        events: 3,
        messages: 3,
        identities: 1,
      },
    ];
    for (const [index, step] of steps.entries()) {
      runtimeConfigState.value = { logging: { audit: step.audit } };
      unsubs.reconcileAuditPolicy(runtimeConfigState.value);
      const runId = `live-audit-${index}`;
      emitAgentAuditEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
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
        recorded: step.events,
        messages: step.messages,
        identityRecorded: step.identities,
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
    expect(auditTestState.recorded).toBe(1);
    runtimeConfigState.value = { logging: { audit: { enabled: false } } };
    emitAgentAuditEvent({
      runId: "disabled-again",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 3_000 },
    });
    expect(auditTestState.recorded).toBe(1);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce(), { interval: 1 });
    warn.mockClear();
    await unsubs.agentUnsub();
    expect(auditTestState.stopped).toBe(1);
  });
}
