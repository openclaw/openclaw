import { listExecSessionsForCancellation } from "../agents/bash-process-registry.js";
import { listSubagentRunsForRequester } from "../agents/subagents/registry/subagent-registry-read.js";
import { isCompetingSessionControllerWorkActive } from "../sessions/session-controller.context.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

/** Work that must settle before a conversation's workspace changes; undefined when idle. */
export function describeSessionWorkspaceBlocker(params: {
  context: Pick<GatewayRequestContext, "terminalSessions">;
  target: { agentId: string; sessionKey: string; storePath: string };
  sessionId: string;
}): string | undefined {
  const identities = [params.target.sessionKey, params.sessionId];
  // A handoff holds queued follow-ups; only competing execution blocks the change.
  // An exited, finalized process cannot compete, and its output stays readable
  // through process log, so an unread result (including a requested stop) is not busy.
  const process = listExecSessionsForCancellation().find(
    (candidate) =>
      candidate.agentId === params.target.agentId &&
      (candidate.sessionKey === params.target.sessionKey ||
        candidate.scopeKey === params.target.sessionKey) &&
      (!candidate.exited ||
        candidate.finalizing ||
        candidate.cleanupUncertain ||
        candidate.finalizationFailed),
  );
  const describeProcess = (exec: NonNullable<typeof process>) =>
    !exec.exited
      ? `background exec ${exec.id} is still running; poll or kill it`
      : exec.finalizing
        ? `background exec ${exec.id} is still cleaning up; poll it until it settles`
        : `background exec ${exec.id} could not confirm its cleanup; inspect it with process log`;
  const child = () =>
    listSubagentRunsForRequester(params.target.sessionKey, {
      requesterAgentId: params.target.agentId,
      requesterStorePath: params.target.storePath,
    }).find(
      (run) =>
        run.execution.endedAt === undefined ||
        run.killReconciliation ||
        run.requesterSettleWake ||
        run.delivery?.status === "pending" ||
        run.delivery?.status === "in_progress",
    );
  const blockingChild = process ? undefined : child();
  return process
    ? describeProcess(process)
    : blockingChild
      ? `child ${blockingChild.childSessionKey} has not finished or delivered its result`
      : params.context.terminalSessions?.listAgent({
            kind: "agent",
            agentId: params.target.agentId,
            agentSessionKey: params.target.sessionKey,
            agentSessionId: params.sessionId,
          }).length
        ? "a terminal is still open for this conversation"
        : isCompetingSessionControllerWorkActive(
              params.target.storePath,
              identities,
              params.target.agentId,
            ) ||
            isCompetingSessionControllerWorkActive(
              `agent:${params.target.agentId}`,
              identities,
              params.target.agentId,
            )
          ? "another run of this conversation is still active"
          : undefined;
}
