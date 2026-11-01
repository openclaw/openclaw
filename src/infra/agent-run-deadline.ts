import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type AgentRunDeadlineRenewer = () => boolean;

function getRenewers(): Map<string, AgentRunDeadlineRenewer> {
  return resolveGlobalSingleton(
    Symbol.for("openclaw.agentRunDeadline.renewers"),
    () => new Map<string, AgentRunDeadlineRenewer>(),
  );
}

/** The Gateway owns reply deadlines; fallback only requests a fresh attempt budget. */
export function registerAgentRunDeadlineRenewer(
  runId: string,
  renew: AgentRunDeadlineRenewer,
): () => void {
  const renewers = getRenewers();
  renewers.set(runId, renew);
  return () => {
    if (renewers.get(runId) === renew) {
      renewers.delete(runId);
    }
  };
}

export function renewAgentRunDeadline(runId: string | undefined): boolean {
  return runId ? (getRenewers().get(runId)?.() ?? false) : false;
}
