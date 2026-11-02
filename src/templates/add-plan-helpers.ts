import { stableStringify } from "@openclaw/normalization-core";
import type { AgentConfig } from "../config/types.agents.js";
import type { TemplateAddPlan } from "./types.js";

export function planWithPackageActions(
  plan: TemplateAddPlan,
  predicate: (action: TemplateAddPlan["actions"][number]) => boolean,
): TemplateAddPlan {
  return {
    ...plan,
    actions: plan.actions.filter((action) => action.kind !== "package" || predicate(action)),
  };
}

export function sameCommittedAgent(existingAgent: AgentConfig, plan: TemplateAddPlan): boolean {
  return stableStringify(existingAgent) === stableStringify(plan.agent.config);
}
