import { publishAgentDeletionWorkAdmission } from "../sessions/session-agent-work-admission.js";
import { isSessionStoreTopologyChange, sessionChanges } from "../sessions/session-row-changes.js";
import { listPendingAgentDeletionJournalsAsync } from "../state/agent-deletion-journal.js";
import { deleteGatewayAgent } from "./server-methods/agents-delete.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

async function restorePendingDeletionFences() {
  let changed: boolean;
  const unsubscribe = sessionChanges.subscribeFacts((change) => {
    if (isSessionStoreTopologyChange(change)) {
      changed = true;
    }
  });
  try {
    for (;;) {
      changed = false;
      const pending = await listPendingAgentDeletionJournalsAsync();
      if (changed) {
        continue;
      }
      for (const journal of pending.entries) {
        publishAgentDeletionWorkAdmission({ agentId: journal.agentId }, journal.operationId, true);
      }
      return pending;
    }
  } finally {
    unsubscribe();
  }
}

/** Restart resumes the durable intent through the same owner as agents.delete. */
export async function resumeAgentDeletions(
  context: GatewayRequestContext,
  signal?: AbortSignal,
): Promise<void> {
  const { entries, manualTemplateAgentIds } = await restorePendingDeletionFences();
  for (const agentId of manualTemplateAgentIds) {
    context.logGateway.warn(
      `Template ${agentId} removal remains pending; retry its Template removal plan.`,
    );
  }
  for (const journal of entries) {
    if (signal?.aborted) {
      return;
    }
    try {
      const result = await deleteGatewayAgent(journal.agentId, journal.deleteFiles, context, {
        recoveryOperationId: journal.operationId,
        detach: journal.phase === "detach-draining" || journal.phase === "detach-retiring",
      });
      if (result.purgeFailed || result.failed?.length) {
        context.logGateway.warn(`Agent ${journal.agentId} deletion cleanup remains pending.`);
      }
    } catch (error) {
      context.logGateway.warn(
        `Agent ${journal.agentId} deletion recovery failed: ${String(error)}`,
      );
    }
  }
}
