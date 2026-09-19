import type { ClawRemovePlanAction } from "./lifecycle-remove-contract.js";

/** Plans the agentState/sessionIndex/sessionTranscripts retain-vs-trash actions for removal. */
export function planClawAgentStateRetention(params: {
  agentId: string;
  agentDir?: string;
  sessionsDir: string;
  retainHistoricalAgentState: boolean;
  sharedAgentDir: boolean;
  sharedSessionsDir: boolean;
  modified: boolean;
}): ClawRemovePlanAction[] {
  const { agentId, retainHistoricalAgentState: retain, modified: blocked } = params;
  const retainAgentDir = retain || params.sharedAgentDir;
  const retainSessionsDir = retain || params.sharedSessionsDir;
  const actions: ClawRemovePlanAction[] = params.agentDir
    ? [
        {
          kind: "agentState",
          id: agentId,
          action: retainAgentDir ? "retain" : "trash",
          target: params.agentDir,
          blocked,
          ...(retainAgentDir
            ? {
                reason: params.sharedAgentDir
                  ? "Agent directory contains state owned by another agent."
                  : "Agent state existed before this Claw adopted the agent.",
              }
            : {}),
        },
      ]
    : [];
  actions.push(
    {
      kind: "sessionIndex",
      id: agentId,
      action: retain ? "retain" : "delete",
      target: `session store entries for agent:${agentId}`,
      blocked,
      ...(retain ? { reason: "Session history existed before this Claw adopted the agent." } : {}),
    },
    {
      kind: "sessionTranscripts",
      id: agentId,
      action: retainSessionsDir ? "retain" : "trash",
      target: params.sessionsDir,
      blocked,
      ...(retainSessionsDir
        ? {
            reason: params.sharedSessionsDir
              ? "Session directory contains state owned by another agent."
              : "Session transcripts existed before this Claw adopted the agent.",
          }
        : {}),
    },
  );
  return actions;
}
