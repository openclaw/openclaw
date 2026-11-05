import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { getInProcessGatewayRequestContext } from "../../plugins/runtime/gateway-request-scope.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";

/** Only the existing committed child-batch owner calls this when its in-memory return is gone. */
export async function recoverGoalSuccessorAfterChildSettlement(
  entries: readonly SubagentRunRecord[],
  delivered: boolean,
): Promise<void> {
  const first = entries[0];
  const context = getInProcessGatewayRequestContext();
  if (!delivered || !first?.requesterAgentId || !first.requesterSessionKey || !context) {
    return;
  }
  const target = {
    agentId: first.requesterAgentId,
    sessionKey: first.requesterSessionKey,
    storePath:
      first.requesterStorePath ??
      resolveSessionStorePathCore(context.getRuntimeConfig().session?.store, {
        agentId: first.requesterAgentId,
      }),
  };
  const entry = await readSessionEntryReadOnlyInWorker(target);
  const successor = entry?.goalSuccessor;
  if (
    !successor ||
    !entries.every(
      (child) =>
        child.requesterSessionKey === target.sessionKey &&
        child.requesterAgentId === target.agentId &&
        (successor.childRunIds
          ? successor.childRunIds.includes(child.runId)
          : child.requesterTurnRunId === successor.sourceRunId),
    )
  ) {
    return;
  }
  // The existing Gateway/root admission lifetime still owns cancellation and Stop.
  const { recoverSessionGoalSuccessor } =
    await import("../../gateway/session-goal-successor-recovery.js");
  await recoverSessionGoalSuccessor({
    context,
    target,
    successor,
    signal: getGatewayRestartDrainSignal(),
    log: context.logGateway,
  });
}
