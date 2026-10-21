import { createCronRunDiagnosticsFromAgentResult } from "../../cron/run-diagnostics.js";
import { projectCronRunUsage } from "../../cron/run-telemetry.js";
import { consumeCronNextCheckProposal } from "../../infra/agent-run-registry.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
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

/** Project delivery and cadence only after the ordinary invocation completes. */
export async function settleSessionAutomationTurn(params: {
  automation: ScheduledSessionAutomation;
  runId: string;
  deliveryEvidence: Parameters<SessionEventExecution["onTerminal"]>[2];
  prepareCurrent: () => Promise<void>;
  outcome: "completed" | "failed" | "aborted";
}): Promise<
  Pick<SessionEventOutcome, "nextCheckMs" | "sourceDeliveryOutcome" | "automationResult">
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
  return {
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
