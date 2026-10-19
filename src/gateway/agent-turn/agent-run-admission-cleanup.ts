import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { repairMainSessionRecoveryMutation } from "../../agents/main-session-recovery/main-session-recovery-lifecycle.js";
import { scheduleMainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import type { MainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import type { PreparedModelRuntimeLease } from "../../agents/prepared-model-runtime.js";
import type { FollowupCompletionOwner } from "../../agents/subagents/completion/session-followup-completion.types.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { isSameSubagentRunOwner } from "../../agents/subagents/registry/subagent-run-generation.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import type { SessionEffectRef } from "../../sessions/session-controller.lifecycle.js";
import type { registerChatAbortController } from "../chat-abort.js";
import { formatForLog } from "../ws-log.js";
import { settleUnstartedGatewayFollowup } from "./agent-run-subagent.js";
import type { AgentTurnContext } from "./types.js";

/** Retire rejected preparation only after its adopted task and runtime resources settle. */
export async function cleanupRejectedAgentRunAdmission({
  runId,
  context,
  incognito,
  activeRunAbort,
  activeGatewayWorkAdmission,
  admittedRunIdentity,
  releaseCallerAuthority,
  restoreAdmittedRestartRecoveryInterrupted,
  lease,
  completion,
  adopted,
  admissionReleased,
  failure,
}: {
  runId: string;
  context: AgentTurnContext;
  incognito?: boolean;
  activeRunAbort: ReturnType<typeof registerChatAbortController>;
  activeGatewayWorkAdmission?: SessionEffectRef;
  admittedRunIdentity: Parameters<typeof settleUnstartedGatewayFollowup>[0]["admittedRunIdentity"];
  releaseCallerAuthority?: () => void;
  restoreAdmittedRestartRecoveryInterrupted?: () => Promise<
    MainSessionRecoveryPendingTarget | undefined
  >;
  lease?: PreparedModelRuntimeLease;
  completion?: FollowupCompletionOwner;
  adopted?: SubagentRunRecord;
  admissionReleased: boolean;
  failure?: string;
}): Promise<void> {
  let pendingRecovery: MainSessionRecoveryPendingTarget | undefined;
  try {
    if (adopted) {
      await runWithGatewayDetachedWorkContinuation(async () => {
        const runtime = await import("../../agents/subagents/registry/subagent-registry.js");
        const ownsAdoption = () =>
          isSameSubagentRunOwner(
            getLatestLiveSubagentRunByChildSessionKey(
              adopted.childSessionKey,
              undefined,
              adopted.childAgentId,
            ),
            adopted,
          );
        if (!ownsAdoption()) {
          return;
        }
        const settled = await runtime.finalizeInterruptedSubagentRun({
          runId: adopted.runId,
          expectedEntry: adopted,
          error: failure ?? "Parent resume admission ended before acceptance.",
          suppressSessionEffects: true,
        });
        if (!settled && ownsAdoption()) {
          throw new Error(
            "Adopted parent resume could not be durably settled after admission rejection",
          );
        }
      }, "subagents:unstarted-resume");
    }
    if (completion) {
      await settleUnstartedGatewayFollowup({
        completion,
        runId,
        admittedRunEntry: activeRunAbort.entry,
        admittedRunIdentity,
        context,
        isIncognito: incognito,
        outcome: buildAgentRunTerminalOutcome({
          status: activeRunAbort.controller.signal.aborted ? "timeout" : "error",
          stopReason: activeRunAbort.controller.signal.aborted
            ? (activeRunAbort.entry?.adapter.abortStopReason ?? "rpc")
            : undefined,
          error: failure ?? "Follow-up admission ended before acceptance.",
        }),
      });
    }
  } finally {
    try {
      if (restoreAdmittedRestartRecoveryInterrupted) {
        pendingRecovery = await repairMainSessionRecoveryMutation({
          mutation: restoreAdmittedRestartRecoveryInterrupted,
          onError: (error) =>
            context.logGateway.warn(
              `failed to restore unaccepted restart recovery: ${formatForLog(error)}`,
            ),
        });
      }
    } finally {
      try {
        await lease?.[Symbol.asyncDispose]();
      } finally {
        try {
          releaseCallerAuthority?.();
          activeRunAbort.cleanup();
          if (!admissionReleased) {
            activeGatewayWorkAdmission?.release();
          }
        } finally {
          completion?.finishExecution(runId);
          scheduleMainSessionRecoveryPendingTarget(pendingRecovery);
        }
      }
    }
  }
}
