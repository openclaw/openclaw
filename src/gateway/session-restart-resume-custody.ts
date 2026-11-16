import {
  getSubagentRunsForRequesterSession,
  subagentRuns,
} from "../agents/subagents/registry/subagent-registry-memory.js";
import { resumeSubagentRun } from "../agents/subagents/registry/subagent-registry.js";
import { owesRequesterCompletion } from "../agents/subagents/registry/subagent-requester-settle-identity.js";
import { isYieldedSubagentRun } from "../agents/subagents/registry/subagent-run-liveness.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import {
  GatewayDrainingError,
  isGatewayRestartDraining,
} from "../process/gateway-work-admission.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type {
  PreparedRestartStore,
  RestartResumeParams,
} from "./session-restart-resume-discovery.js";

/** Readmit owed completions by key; each row restores its own saved origin when it delivers. */
export async function prepareRestartCompletionCustody(
  { context, signal, log }: RestartResumeParams,
  { target, entries }: Pick<PreparedRestartStore, "target" | "entries">,
): Promise<{ assertCurrent: () => void; resume: () => void }> {
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (isGatewayRestartDraining()) {
      throw new GatewayDrainingError();
    }
  };
  assertCurrent();
  const recovered: string[] = [];
  for (const { sessionKey, entry } of entries) {
    const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId;
    for (const child of entry.archivedAt === undefined
      ? getSubagentRunsForRequesterSession(sessionKey)
      : []) {
      if (
        child.requesterAgentId !== agentId ||
        !subagentRuns.isCompletionAuthorityRetired(child) ||
        !(
          (isYieldedSubagentRun(child) && owesRequesterCompletion(child)) ||
          child.requesterSettleWake !== undefined ||
          ["pending", "in_progress", "failed"].includes(child.delivery?.status ?? "")
        )
      ) {
        continue;
      }
      try {
        bindGatewayContextResolver(child, context.resolveGatewayContext);
        subagentRuns.admitCompletion(child);
        recovered.push(child.runId);
      } catch (error) {
        log.warn(`Restart completion recovery failed for ${sessionKey}: ${String(error)}`);
      }
    }
  }
  return {
    assertCurrent,
    resume: () => {
      signal.throwIfAborted();
      if (!isGatewayRestartDraining()) {
        recovered.forEach((runId) => resumeSubagentRun(runId));
      }
    },
  };
}
