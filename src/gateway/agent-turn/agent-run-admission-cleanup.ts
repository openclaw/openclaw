import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { repairMainSessionRecoveryMutation } from "../../agents/main-session-recovery/main-session-recovery-lifecycle.js";
import { scheduleMainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import type { MainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import type { PreparedModelRuntimeLease } from "../../agents/prepared-model-runtime.js";
import type { FollowupCompletionOwner } from "../../agents/subagents/completion/session-followup-completion.types.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { clearAgentRunContext, getAgentRunContext } from "../../infra/agent-run-registry.js";
import type { SessionEffectRef } from "../../sessions/session-controller.lifecycle.js";
import { getRpcSource, hasRpcSource } from "../../sessions/session-controller.rpc-sources.js";
import type { registerChatAbortController } from "../chat-abort.js";
import { formatForLog } from "../ws-log.js";
import {
  settleUnstartedGatewayFollowup,
  settleUnstartedGatewayParentResume,
} from "./agent-run-subagent.js";
import type { AgentTurnContext } from "./types.js";

/** Retire rejected preparation only after its adopted task and runtime resources settle. */
export async function cleanupRejectedAgentRunAdmission({
  runId,
  context,
  incognito,
  activeRunAbort,
  activeGatewayWorkAdmission,
  admittedRunIdentity,
  admittedRunContext,
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
  admittedRunContext?: ReturnType<typeof getAgentRunContext>;
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
      await settleUnstartedGatewayParentResume(adopted, failure);
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
          try {
            releaseCallerAuthority?.();
          } finally {
            // A retired source may release its context, but a successor with the
            // same protocol ID owns its own registration and must remain intact.
            if (
              admittedRunContext &&
              admittedRunIdentity &&
              getAgentRunContext(runId) === admittedRunContext &&
              (!hasRpcSource(runId) || getRpcSource(runId) === activeRunAbort.entry) &&
              activeRunAbort.entry?.adapter.operationalRunInstance ===
                admittedRunIdentity.operationalRunInstance
            ) {
              clearAgentRunContext(runId, admittedRunIdentity.lifecycleGeneration);
            }
          }
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
