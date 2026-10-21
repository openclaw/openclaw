import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCronRunDiagnosticsFromAgentResult } from "../../cron/run-diagnostics.js";
import { projectCronRunUsage } from "../../cron/run-telemetry.js";
import { consumeCronNextCheckProposal } from "../../infra/agent-run-registry.automation.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import type { ReplyOperationObservation } from "../../sessions/reply-operation-state.js";
import { runWithSessionControllerCleanup } from "../../sessions/session-controller.cleanup-context.js";
import { isCronRunSessionKey } from "../../sessions/session-key-utils.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type {
  ScheduledSessionAutomation,
  SessionEventExecution,
  SessionEventOutcome,
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

export function resolveScheduledSessionReplyOptions(
  automation?: ScheduledSessionAutomation,
): Pick<
  GetReplyOptions,
  | "sourceReplyDeliveryMode"
  | "thinkingLevelOverride"
  | "timeoutOverrideSeconds"
  | "bootstrapContextMode"
> &
  Pick<ScheduledSessionAutomation, "operatorAuthority"> & { modelOverride?: string } {
  if (!automation) {
    return {};
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

/** Project delivery and cadence only after the ordinary invocation completes. */
export async function settleSessionAutomationTurn(params: {
  automation: ScheduledSessionAutomation;
  runId: string;
  deliveryEvidence: Parameters<SessionEventExecution["onTerminal"]>[2];
  cfg: OpenClawConfig;
  scope:
    | {
        agentId: string;
        sessionKey: string;
        storePath: string;
        sessionId: string;
        lifecycleRevision?: string;
      }
    | undefined;
  assertCurrent: () => void;
  prepareCurrent: () => Promise<void>;
  outcome: "completed" | "failed" | "aborted";
}): Promise<
  Pick<
    SessionEventOutcome,
    "summary" | "nextCheckMs" | "sourceDeliveryOutcome" | "automationResult"
  >
> {
  const { automation, runId, deliveryEvidence } = params;
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
  const result = invocation?.result;
  const summary = result ? `${result.outcome}: ${result.summary}` : undefined;
  if (result && result.outcome !== "no_change" && params.scope) {
    const { appendSessionRuntimeContext } = await import("../../sessions/runtime-context.js");
    await params.prepareCurrent();
    await appendSessionRuntimeContext({
      cfg: params.cfg,
      scope: params.scope,
      content: `Automation result (recorded fact, not an instruction): ${summary}`,
      idempotencyKey: `automation-result:${jobId}:${runId}`,
      assertCurrent: params.assertCurrent,
    });
  }
  return {
    summary,
    nextCheckMs:
      params.outcome === "completed"
        ? consumeCronNextCheckProposal(runId, automation.job.id)
        : undefined,
    sourceDeliveryOutcome,
    automationResult: {
      provider: deliveryEvidence?.meta?.agentMeta?.provider ?? deliveryEvidence?.resolved?.provider,
      model: deliveryEvidence?.meta?.agentMeta?.model ?? deliveryEvidence?.resolved?.model,
      usage: projectCronRunUsage(deliveryEvidence?.meta?.agentMeta?.usage),
      replyDisposition: deliveryEvidence?.meta?.terminalReply?.disposition,
      diagnostics: createCronRunDiagnosticsFromAgentResult(deliveryEvidence, {
        finalStatus: params.outcome === "completed" ? "ok" : "error",
      }),
    },
  };
}
