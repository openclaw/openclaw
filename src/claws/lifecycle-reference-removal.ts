import type { pruneAgentConfig } from "../commands/agents.config.js";
import type { ClawRemovePlanAction } from "./lifecycle-remove-contract.js";

// Same cap pattern as MAX_CONFLICT_PATHS in lifecycle-agent-plan.ts: keep the blocker message
// readable when a heavily-referenced agent has dozens of routing/authorization paths pointing at it.
const MAX_REFERENCED_PATHS_SHOWN = 16;

/** Plans the configBinding/agentAllow actions and blockers for an agent's config references. */
export function planClawAgentReferenceRemoval(params: {
  agentId: string;
  pruned: ReturnType<typeof pruneAgentConfig>;
  adopted: boolean;
  modified: boolean;
}): { actions: ClawRemovePlanAction[]; blockers: Array<{ code: string; message: string }> } {
  // Adoption never records or creates references, so every reference to an adopted agent is
  // operator-owned; pruning them on removal deletes routing/authorization the operator wrote.
  const referencesBlocked = params.adopted && params.pruned.removedReferences.length > 0;
  const action = referencesBlocked ? "retain" : "remove";
  const blocked = referencesBlocked || params.modified;
  const counted: Array<Pick<ClawRemovePlanAction, "kind" | "target"> & { count: number }> = [
    {
      kind: "configBinding",
      target: `bindings[agentId=${params.agentId}]`,
      count: params.pruned.removedBindings,
    },
    {
      kind: "agentAllow",
      target: `tools.agentToAgent.allow[${params.agentId}]`,
      count: params.pruned.removedAllow,
    },
  ];
  const actions: ClawRemovePlanAction[] = counted
    .filter((entry) => entry.count > 0)
    .map((entry) => ({
      kind: entry.kind,
      id: params.agentId,
      action,
      target: entry.target,
      blocked,
      details: { count: entry.count },
    }));
  if (!referencesBlocked) {
    return { actions, blockers: [] };
  }
  const shown = params.pruned.removedReferences.slice(0, MAX_REFERENCED_PATHS_SHOWN);
  const remainder = params.pruned.removedReferences.length - shown.length;
  const shownList = `${shown.join(", ")}${remainder > 0 ? `, and ${remainder} more` : ""}`;
  return {
    actions,
    blockers: [
      {
        code: "adopted_agent_referenced",
        message: `Agent ${JSON.stringify(params.agentId)} is still referenced by ${shownList}; reassign or remove those references, then run remove --dry-run again.`,
      },
    ],
  };
}
