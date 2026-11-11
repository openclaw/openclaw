import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasPendingAutomationContinuation } from "../../cron/automation-result.js";
import {
  createCronRunDiagnosticsFromAgentResult,
  mergeCronRunDiagnostics,
} from "../../cron/run-diagnostics.js";
import { projectCronRunUsage } from "../../cron/run-telemetry.js";
import {
  CRON_SELECTED_CONVERSATION_UNBOUND_MESSAGE,
  resolveCronSelectedConversation,
} from "../../cron/session-target.js";
import { consumeCronNextCheckProposal } from "../../infra/agent-run-registry.automation.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import type { ReplyOperationObservation } from "../../sessions/reply-operation-state.js";
import { runWithSessionControllerCleanup } from "../../sessions/session-controller.cleanup-context.js";
import { isCronRunSessionKey } from "../../sessions/session-key-utils.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import {
  getReplyPayloadMetadata,
  isRenderablePayload,
  shouldSuppressReasoningPayload,
  selectAutomationReplyPayloads,
} from "../reply-payload.js";
import type {
  ScheduledSessionAutomation,
  SessionEventExecution,
  SessionEventOptions,
  SessionEventOutcome,
  SessionEventTarget,
} from "./session-event-contract.js";

const log = createSubsystemLogger("session-events");

/** Retain the event's exact cleanup destination before config or state remapping. */
export function prepareCronRunContinuationCleanup(
  sessionKey: string,
  storePath: string,
  env?: NodeJS.ProcessEnv,
): (() => void) | undefined {
  if (!isCronRunSessionKey(sessionKey)) {
    return undefined;
  }
  const context = captureOpenClawStateWorkerContext({ env });
  return () => {
    // Cleanup must outlive the completed event's async work scope.
    void runWithGatewayDetachedWorkContinuation(
      () =>
        runWithSessionControllerCleanup(async () => {
          const { removeCronRunContinuationSessionIfIdle } =
            await import("../../cron/run-continuation-cleanup.js");
          await removeCronRunContinuationSessionIfIdle(sessionKey, undefined, context, storePath);
        }),
      "session:event-cleanup",
    ).catch((error: unknown) => {
      log.warn("Could not remove settled cron continuation", { error: String(error) });
    });
  };
}

export function resolveSessionEventReplyOptions(
  options: Pick<SessionEventOptions, "scheduledAutomation" | "replyExpectation">,
): Pick<
  GetReplyOptions,
  | "sourceReplyDeliveryMode"
  | "thinkingLevelOverride"
  | "timeoutOverrideSeconds"
  | "bootstrapContextMode"
> &
  Pick<ScheduledSessionAutomation, "operatorAuthority"> &
  Pick<SessionEventOptions, "replyExpectation"> & { modelOverride?: string } {
  const automation = options.scheduledAutomation;
  if (!automation) {
    // A host producer's silence permission travels only through these host-owned options.
    return options.replyExpectation ? { replyExpectation: options.replyExpectation } : {};
  }
  const payload = automation.job.payload;
  return {
    operatorAuthority: automation.operatorAuthority,
    sourceReplyDeliveryMode: "automatic",
    ...(payload.kind === "agentTurn"
      ? {
          modelOverride: payload.model,
          thinkingLevelOverride: payload.thinking,
          timeoutOverrideSeconds: payload.timeoutSeconds,
          bootstrapContextMode: payload.lightContext ? "lightweight" : "full",
        }
      : {}),
  };
}

export type ScheduledAutomationAdmission = Pick<
  SessionEventOutcome,
  "admissionDeferred" | "admissionDeferredReason"
>;

/** Wait behind foreground work, then recheck the same automation's current start policy. */
export async function prepareScheduledAutomationStart(params: {
  automation?: ScheduledSessionAutomation;
  operation: () => ReplyOperationObservation | undefined;
  signal: AbortSignal;
  prepareCurrent: () => Promise<void>;
  admission: ScheduledAutomationAdmission;
  /** Start synchronously with the successful gate, before yielding back to the receipt owner. */
  onReady?: () => void;
}): Promise<void> {
  const { automation, admission } = params;
  for (;;) {
    const decision = automation?.beforeStart?.(params.operation());
    if (decision === undefined || decision === true) {
      params.onReady?.();
      return;
    }
    admission.admissionDeferredReason = typeof decision === "string" ? decision : undefined;
    if (admission.admissionDeferredReason === "busy" && automation?.waitForIdle) {
      automation.onLaneWait?.({ waiting: true });
      try {
        await automation.waitForIdle(params.signal, params.operation());
      } finally {
        automation.onLaneWait?.({ waiting: false });
      }
      await params.prepareCurrent();
      continue;
    }
    admission.admissionDeferred = true;
    throw new Error("Automation admission deferred by its current window or foreground activity");
  }
}

/** Settle the event and publish only its completed automation result. */
export async function settleSessionEventTurn(params: {
  automation?: ScheduledSessionAutomation;
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  binding?: Pick<SessionEventTarget, "sessionId" | "lifecycleRevision">;
  runStartedAt: number;
  signal: AbortSignal;
  assertCurrent: () => void;
  onFailure: (error: string) => void;
  runId: string;
  deliveryEvidence: Parameters<SessionEventExecution["onTerminal"]>[2];
  prepareCurrent: () => Promise<void>;
  outcome: "completed" | "failed" | "aborted";
}): Promise<
  Pick<
    SessionEventOutcome,
    | "summary"
    | "nextCheckMs"
    | "sourceDeliveryOutcome"
    | "automationResult"
    | "conversationResultCommitted"
    | "selectedConversationDelivery"
  >
> {
  const { automation, runId, deliveryEvidence } = params;
  if (params.outcome !== "completed") {
    params.onFailure(
      deliveryEvidence?.meta?.error?.message ||
        deliveryEvidence?.payloads?.find((payload) => payload.isError && payload.text?.trim())
          ?.text ||
        `Session event execution ${params.outcome}`,
    );
  }
  await params.prepareCurrent();
  if (!automation) {
    return {};
  }
  let sourceDeliveryOutcome: SessionEventOutcome["sourceDeliveryOutcome"];
  if (automation.sourceDelivery) {
    const { resolveSourceDeliveryOutcome } =
      await import("../../infra/outbound/source-delivery-plan.js");
    await params.prepareCurrent();
    sourceDeliveryOutcome = resolveSourceDeliveryOutcome(automation.sourceDelivery, {
      didSendViaMessageTool: deliveryEvidence?.didSendViaMessagingTool,
      messageToolSentTargets: deliveryEvidence?.messagingToolSentTargets,
    });
  }
  const jobId = automation.job.id;
  const invocation = getAgentRunContext(runId)?.cronRunsByJobId?.get(jobId);
  if (invocation) {
    invocation.closed = true;
  }
  const result = hasPendingAutomationContinuation(deliveryEvidence?.meta)
    ? undefined
    : invocation?.result;
  const summary =
    params.outcome === "completed" && result?.outcome !== "no_change" ? result?.summary : undefined;
  const settled = {
    summary,
    nextCheckMs:
      params.outcome === "completed"
        ? consumeCronNextCheckProposal(runId, automation.job.id)
        : undefined,
    sourceDeliveryOutcome,
    automationResult: {
      result,
      provider: deliveryEvidence?.meta?.agentMeta?.provider ?? deliveryEvidence?.resolved?.provider,
      model: deliveryEvidence?.meta?.agentMeta?.model ?? deliveryEvidence?.resolved?.model,
      usage: projectCronRunUsage(deliveryEvidence?.meta?.agentMeta?.usage),
      replyDisposition: deliveryEvidence?.meta?.terminalReply?.disposition,
      diagnostics: createCronRunDiagnosticsFromAgentResult(deliveryEvidence, {
        finalStatus: params.outcome === "completed" ? "ok" : "error",
      }),
    },
  };

  // Execution prose is audit-only. Publish the settled answer once,
  // independently of whether this occurrence requests a notification.
  const visiblePayloads = selectAutomationReplyPayloads(
    deliveryEvidence?.payloads ?? [],
    settled.automationResult.result?.outcome === "no_change",
    deliveryEvidence?.meta?.terminalReply?.disposition === "silent",
  ).filter((payload) => !shouldSuppressReasoningPayload(payload) && isRenderablePayload(payload));
  // Source-reply mirrors satisfy only the execution transcript, not another destination.
  const payloads = visiblePayloads.filter(
    (payload) =>
      getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror?.sessionKey !==
      params.sessionKey,
  );
  if (
    params.outcome === "completed" &&
    !hasPendingAutomationContinuation(deliveryEvidence?.meta) &&
    visiblePayloads.length > 0
  ) {
    const binding = params.binding;
    if (!binding?.sessionId) {
      throw new Error("Automation result has no admitted conversation generation");
    }
    const { commitCronConversationResult } = await import("../../cron/conversation-result.js");
    const committed =
      payloads.length > 0
        ? await commitCronConversationResult({
            config: params.config,
            agentId: params.agentId,
            jobId: automation.job.id,
            runStartedAt: automation.job.state.runningAtMs ?? params.runStartedAt,
            conversation: {
              sessionKey: params.sessionKey,
              sessionId: binding.sessionId,
              lifecycleRevision: binding.lifecycleRevision,
            },
            payloads,
            signal: params.signal,
            deliveryAttemptFence: {
              beforeAttempt: async () => {
                await params.prepareCurrent();
                await automation.deliveryAttemptFence?.beforeAttempt();
                params.assertCurrent();
              },
              assertCurrent: () => {
                params.assertCurrent();
                automation.deliveryAttemptFence?.assertCurrent();
              },
            },
          })
        : { ok: true as const, skipped: true as const, diagnostics: undefined };
    if (!committed.ok) {
      throw new Error(committed.reason);
    }
    if (committed.diagnostics) {
      settled.automationResult.diagnostics = mergeCronRunDiagnostics(
        settled.automationResult.diagnostics,
        committed.diagnostics,
      );
    }
    const executionResult = {
      ...settled,
      conversationResultCommitted: committed.skipped ? undefined : (true as const),
    };
    const selected =
      automation.job.delivery?.mode === "announce"
        ? resolveCronSelectedConversation(automation.job)
        : undefined;
    if (selected === undefined) {
      return executionResult;
    }
    // A selected announcement is a second result destination, not permission to replace
    // the persistent execution's settled reply or inherit its remembered transport.
    try {
      if (selected === null) {
        throw new Error(CRON_SELECTED_CONVERSATION_UNBOUND_MESSAGE);
      }
      if (
        selected.sessionKey === params.sessionKey &&
        selected.sessionId === binding.sessionId &&
        selected.lifecycleRevision === binding.lifecycleRevision
      ) {
        const alreadyMirrored =
          payloads.length === 0 &&
          visiblePayloads.some((payload) => {
            const mirror = getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror;
            return Boolean(mirror?.text?.trim() || mirror?.mediaUrls?.some((url) => url.trim()));
          });
        if (committed.skipped && !alreadyMirrored) {
          throw new Error("selected result has no conversation projection");
        }
        return { ...executionResult, selectedConversationDelivery: { status: "delivered" } };
      }
      const delivered = await commitCronConversationResult({
        config: params.config,
        agentId: params.agentId,
        jobId: automation.job.id,
        runStartedAt: automation.job.state.runningAtMs ?? params.runStartedAt,
        conversation: selected,
        payloads: visiblePayloads,
        signal: params.signal,
        deliveryAttemptFence: {
          beforeAttempt: async () => {
            await params.prepareCurrent();
            await automation.beforeDeliver?.();
            params.assertCurrent();
          },
          assertCurrent: () => {
            params.assertCurrent();
            automation.deliveryAttemptFence?.assertCurrent();
            automation.assertDeliveryCurrent?.();
          },
        },
      });
      if (!delivered.ok) {
        throw new Error(delivered.reason);
      }
      if (delivered.skipped) {
        throw new Error("selected result has no conversation projection");
      }
      executionResult.automationResult.diagnostics = mergeCronRunDiagnostics(
        executionResult.automationResult.diagnostics,
        delivered.diagnostics,
      );
      return { ...executionResult, selectedConversationDelivery: { status: "delivered" } };
    } catch (error) {
      return {
        ...executionResult,
        selectedConversationDelivery: {
          status: "not-delivered",
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  return settled;
}
