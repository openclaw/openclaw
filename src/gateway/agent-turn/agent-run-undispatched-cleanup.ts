import { repairMainSessionRecoveryMutation } from "../../agents/main-session-recovery/main-session-recovery-lifecycle.js";
import { scheduleMainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import {
  releaseMainSessionRecoveryOwner,
  type MainSessionRecoveryPendingTarget,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { emitSessionsChanged } from "../server-methods/session-change-event.js";
import type { createAgentRunDiagnostics } from "./agent-run-diagnostics.js";
import type { StartAgentRunExecutionParams } from "./agent-run-execution-types.js";
export async function cleanupUndispatchedAgentRun(options: {
  execution: StartAgentRunExecutionParams;
  pendingRecovery: MainSessionRecoveryPendingTarget | undefined;
  cleanupAdmittedRun: () => Promise<void>;
  warning: ReturnType<typeof createAgentRunDiagnostics>["warning"];
}): Promise<void> {
  const params = options.execution;
  const { prepared } = params;
  let pendingRecovery = options.pendingRecovery;
  const cleanupAdmittedRun = options.cleanupAdmittedRun;
  try {
    const restoreAdmittedRecovery = prepared.restoreAdmittedRestartRecoveryInterrupted;
    if (restoreAdmittedRecovery) {
      pendingRecovery ??= await repairMainSessionRecoveryMutation({
        mutation: restoreAdmittedRecovery,
        onDeferredSuccess: scheduleMainSessionRecoveryPendingTarget,
        onError: options.warning("failed to restore undispatched restart recovery"),
      });
    }
  } finally {
    try {
      await params.releaseCronContinuationClaimWithRecovery();
    } finally {
      try {
        pendingRecovery ??= await releaseMainSessionRecoveryOwner(
          params.mainRestartRecoveryOwnerLease,
        );
      } catch (err) {
        options.warning("failed to release undispatched main restart recovery owner")(err);
      } finally {
        try {
          await cleanupAdmittedRun();
        } finally {
          scheduleMainSessionRecoveryPendingTarget(pendingRecovery);
        }
      }
    }
  }
}

export function publishAgentRunInputSettlement(params: StartAgentRunExecutionParams): void {
  const { prepared } = params;
  if (prepared.userTurn.recorder && params.resolvedSessionKey) {
    emitSessionsChanged(
      params.context,
      {
        sessionKey: params.resolvedSessionKey,
        agentId: params.activeSessionAgentId,
        reason: "agent.input.settled",
      },
      { accessChanged: false },
    );
  }
}
