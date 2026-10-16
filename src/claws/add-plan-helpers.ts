import { stableStringify } from "@openclaw/normalization-core";
import type { AgentConfig } from "../config/types.agents.js";
import type { ClawAddPlan } from "./types.js";

export function planWithPackageActions(
  plan: ClawAddPlan,
  predicate: (action: ClawAddPlan["actions"][number]) => boolean,
): ClawAddPlan {
  return {
    ...plan,
    actions: plan.actions.filter((action) => action.kind !== "package" || predicate(action)),
  };
}

export function sameCommittedAgent(existingAgent: AgentConfig, plan: ClawAddPlan): boolean {
  return stableStringify(existingAgent) === stableStringify(plan.agent.config);
}
