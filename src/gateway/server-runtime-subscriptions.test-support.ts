import { assert, expect, it, vi } from "vitest";
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
import type { SubsystemLogger } from "../logging/subsystem.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { registerChatAbortController, type ChatAbortControllerEntry } from "./chat-abort.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import type { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";

type SubscriptionParams = Parameters<typeof startGatewayEventSubscriptions>[0];
type AuditConfig = NonNullable<NonNullable<OpenClawConfig["logging"]>["audit"]>;
type InstallHandler = (factory: typeof import("./server-chat.js").createAgentEventHandler) => void;

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
    createParams: (): SubscriptionParams => {
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
  params: SubscriptionParams,
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
  assert(registration.entry, "expected registered chat abort controller");
  return { ...registration, entry: registration.entry };
}

export const readLifecycleState = (entry: ChatAbortControllerEntry) => ({
  projectSessionActive: entry.projectSessionActive,
  projectSessionTerminalPending: entry.projectSessionTerminalPending,
  projectSessionTerminalObservedAt: entry.projectSessionTerminalObservedAt,
  projectSessionTerminalPersistence: entry.projectSessionTerminalPersistence,
  projectSessionTerminalPersisted: entry.projectSessionTerminalPersisted,
  registrationCleanupRequested: entry.registrationCleanupRequested,
});

export const lifecycleState = (
  projectSessionActive: boolean | undefined,
  projectSessionTerminalPending?: boolean,
  projectSessionTerminalObservedAt?: number,
  projectSessionTerminalPersistence?: Promise<void>,
  projectSessionTerminalPersisted?: boolean,
  registrationCleanupRequested?: boolean,
): ReturnType<typeof readLifecycleState> => ({
  projectSessionActive,
  projectSessionTerminalPending,
  projectSessionTerminalObservedAt,
  projectSessionTerminalPersistence,
  projectSessionTerminalPersisted,
  registrationCleanupRequested,
});

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
  const setAudit = (audit: AuditConfig, unsubs?: ReturnType<typeof start>) => {
    runtimeConfigState.value = { logging: { audit } };
    unsubs?.reconcileAuditPolicy(runtimeConfigState.value);
  };
  const emitAudit = (runId: string, startedAt = 1_000) =>
    emitAgentAuditEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt } });
  it("owns channel evidence collection without retiring host routing on audit changes", async () => {
    const unsubs = start();
    const participant = { channelId: "test", participantId: "person-1" };
    const createEvidence = (audit = unsubs.channelAdmissionAudit) =>
      createChannelParticipantAdmissionEvidence({ audit, ...participant });
    const bindEvidence = (context: object) =>
      bindTestChannelParticipantAdmissionEvidence({
        audit: unsubs.channelAdmissionAudit,
        context,
        ...participant,
      });
    const context = {};
    expect(bindEvidence(context)).toBeUndefined();
    const resolveGateway = readChannelContextGatewayContextResolver(context);
    expect(resolveGateway).toBeTypeOf("function");
    const gateway = resolveGateway?.();
    const expectRoutingUnchanged = () => {
      expect(readChannelContextGatewayContextResolver(context)).toBe(resolveGateway);
      expect(resolveGateway?.()).toBe(gateway);
    };
    expect(gateway?.channelAdmissionAudit).toBe(unsubs.channelAdmissionAudit);

    setAudit({ executionIdentity: true }, unsubs);
    const evidence = createEvidence();
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

    const retired = createEvidence();
    expect(retired).toBeDefined();
    setAudit({ enabled: false, executionIdentity: true }, unsubs);
    const disabledContext = {};
    expect(bindEvidence(disabledContext)).toBeUndefined();
    expectRoutingUnchanged();
    expect(
      readChannelContextGatewayContextResolver(disabledContext)?.()?.channelAdmissionAudit,
    ).toBe(unsubs.channelAdmissionAudit);

    setAudit({ executionIdentity: true }, unsubs);
    expect(consumeChannelAdmissionEvidence(retired)).toMatchObject({ ingressState: "unknown" });
    expect(recordChannelAdmissionDecision(evidence, decision)).toBe(false);
    expect(auditTestState.decisionRecorded).toBe(1);
    expectRoutingUnchanged();

    const beforeShutdown = createEvidence();
    expect(beforeShutdown).toBeDefined();
    await unsubs.agentUnsub();
    unsubs.reconcileAuditPolicy({ logging: { audit: { enabled: false } } });
    unsubs.reconcileAuditPolicy(runtimeConfigState.value);
    expect(consumeChannelAdmissionEvidence(beforeShutdown)).toMatchObject({
      ingressState: "unknown",
    });
    expect(createEvidence()).toBeUndefined();

    unsubs.heartbeatUnsub();
    unsubs.transcriptUnsub();
    unsubs.lifecycleUnsub();
    const restarted = start();
    expect(
      consumeChannelAdmissionEvidence(createEvidence(restarted.channelAdmissionAudit)),
    ).toMatchObject({ ingressState: "present", invoker: { state: "present" } });
    expect(consumeChannelAdmissionEvidence(beforeShutdown)).toMatchObject({
      ingressState: "unknown",
    });
  });

  it("applies audit policy changes through the existing event subscriptions", async () => {
    setAudit({ enabled: false });
    const unsubs = start();
    expect(hasExecutionIdentityAdmissionSink()).toBe(true);
    const steps: Array<[AuditConfig, number, number, number]> = [
      [{ enabled: false, messages: "all", executionIdentity: true }, 0, 0, 0],
      [{}, 1, 0, 0],
      [{ messages: "direct", executionIdentity: true }, 2, 1, 1],
      [{ messages: "all" }, 3, 3, 1],
      [{ enabled: false, messages: "all", executionIdentity: true }, 3, 3, 1],
    ];
    for (const [index, [audit, recorded, messages, identityRecorded]] of steps.entries()) {
      setAudit(audit, unsubs);
      const runId = `live-audit-${index}`;
      emitAudit(runId);
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
      const admission = enqueueExecutionIdentityContextAtAdmission(
        {
          runId,
          agentId: "main",
          ingress: { kind: "system", boundary: "gateway.boot", state: "present" },
          runtime: { kind: "embedded" },
        },
        { enabled: true, runtimeInstanceId: "runtime-1" },
      );
      if (audit.executionIdentity && audit.enabled !== false) {
        expect(admission?.accepted).toBe(true);
      }
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
    expect(hasExecutionIdentityAdmissionSink()).toBe(false);
  });

  it("keeps retention maintenance and applies audit enablement to subsequent events", async () => {
    setAudit({ enabled: false });
    const unsubs = start();

    expect(auditTestState.created).toBe(1);
    emitAudit("disabled-private");
    emitAgentEvent({
      runId: "disabled-public",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    expect(auditTestState.recorded).toBe(0);
    runtimeConfigState.value = {};
    emitAudit("resumed-private", 2_000);
    expect(auditTestState.recorded).toBe(1);
    setAudit({ enabled: false });
    emitAudit("disabled-again", 3_000);
    expect(auditTestState.recorded).toBe(1);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce(), { interval: 1 });
    warn.mockClear();
    await unsubs.agentUnsub();
    expect(auditTestState.stopped).toBe(1);
  });
}

export function registerSubscriptionRegistrationTests(
  start: typeof startGatewayEventSubscriptions,
) {
  const { createParams } = createSubscriptionTestFixture();
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
    assert(originalClaim, "Missing original claim");
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
      expect(registration.entry.terminalOutcomeObserved).toBeUndefined();
      expect(readLifecycleState(registration.entry)).toEqual(lifecycleState(true));
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
      expect(readLifecycleState(registration.entry)).toEqual(lifecycleState(true));
      expect(registration.entry.terminalOutcomeObserved).toBeUndefined();
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
  installHandlerFactory: InstallHandler;
  start: (params: SubscriptionParams) => void;
}): void {
  const tailCase = (
    source: string,
    initial?: string,
    committed = [initial ?? "Saved paragraph."],
  ) => ({ source, committed, initial });
  it.each([
    tailCase("plain", "Saved paragraph."),
    tailCase("native raw directive", "[[reply_to_current]]Saved paragraph."),
    tailCase("native partial before directive", "Saved", ["Saved[[reply_to_current]] paragraph."]),
    tailCase("before first bytes"),
    tailCase("identical receipts before first bytes", undefined, [
      "Saved paragraph.",
      "Saved paragraph.",
    ]),
  ])(
    "retires $source by identity before queued continuation without session subscribers",
    async ({ committed, initial }) => {
      const actual = await vi.importActual<typeof import("./server-chat.js")>("./server-chat.js");
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const params = createParams();
      const runId = "run-persisted-tail";
      const identity = {
        sessionKey: "agent:main:main",
        sessionId: "session-persisted-tail",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      };
      const registration = registerSubscriptionChatRun(params, { runId, ...identity });
      claimAgentRunContext(runId, identity);
      const { sessionKey, sessionId } = identity;
      const emitText = (itemId: string, text: string) =>
        emitAgentEvent({ runId, stream: "assistant", data: { itemId, text } });
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
          emitText(`saved-paragraph-${index}`, text);
        }
        emitText("new-paragraph", "Unpersisted tail.");
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
