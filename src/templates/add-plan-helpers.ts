import { stableStringify } from "@openclaw/normalization-core";
import type { AgentConfig } from "../config/types.agents.js";
import type { TemplateAddPlan } from "./types.js";

export function sameCommittedAgent(existingAgent: AgentConfig, plan: TemplateAddPlan): boolean {
  return stableStringify(existingAgent) === stableStringify(plan.agent.config);
}
