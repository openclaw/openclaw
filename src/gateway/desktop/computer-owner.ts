import type { AgentRunDelegatedAuthority } from "../../infra/agent-run-authority.types.js";

/** One physical execution belongs to one exact admitted-run claim. */
export function computerRunOwner(authority: AgentRunDelegatedAuthority): string {
  return JSON.stringify([
    "agent",
    authority.operationalRunInstance.instanceId,
    authority.operationalRunInstance.runId,
    authority.lifecycleGeneration,
    authority.claimId,
  ]);
}
