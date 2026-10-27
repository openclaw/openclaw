import type { PreparedAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";

/** Human replies and operator recovery inherit the retained child's native custody. */
export async function prepareReplySubagentContinuation(
  turn: AgentTurnParams,
  runId: string,
  cfg: OpenClawConfig,
  admission: PreparedAgentRunAdmission,
): Promise<void> {
  const entry = turn.getActiveSessionEntry();
  const provenance = turn.followupRun.run.inputProvenance;
  const operatorRecovery =
    provenance?.kind === "internal_system" &&
    provenance.sourceTool === "sessions.recover" &&
    provenance.sourceSessionKey === turn.sessionKey;
  if (
    !turn.sessionKey ||
    (provenance && provenance.kind !== "external_user" && !operatorRecovery) ||
    !(entry?.spawnedBy || entry?.subagentRole || (entry?.spawnDepth ?? 0) > 0)
  ) {
    return;
  }
  const assertCurrent = () => {
    admission.assertSourceCurrent();
    turn.replyOperation?.abortSignal.throwIfAborted();
    turn.opts?.abortSignal?.throwIfAborted();
  };
  assertCurrent();
  // Browser chat bypasses agent RPC admission. Bind its actual executing run,
  // not a queued/collected input, to the retained child's completion owner.
  const { reactivateCompletedSubagentSession } =
    await import("../../gateway/session-subagent-reactivation.js");
  await reactivateCompletedSubagentSession({
    sessionKey: turn.sessionKey,
    runId,
    ...(operatorRecovery ? {} : { task: turn.followupRun.prompt }),
    gatewayContextResolver:
      readChannelContextGatewayContextResolver(turn.sessionCtx) ??
      getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext,
    assertCurrent,
    session: { cfg, activeSessionAgentId: turn.followupRun.run.agentId, sessionEntry: entry },
  });
  assertCurrent();
}
