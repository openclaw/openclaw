import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ClawAddApplyResult,
  ClawAddPlan,
  ClawCatalogSource,
} from "../agents-home/claws-catalog-client.ts";
import type { ClawPluginAcknowledgement } from "../agents-home/claws-plugin-review.ts";
import type { ClawSkillAcknowledgement } from "../agents-home/claws-skill-review.ts";

export type ClawLifecyclePlan = Omit<ClawAddPlan, "operation"> & {
  operation: "update" | "remove";
};

export type ClawUpdatePlan = Omit<ClawAddPlan, "operation"> & { operation: "update" };
export type ClawUpdateResult = ClawAddApplyResult;

export type ClawRemoveResult = {
  agentId: string;
  status: "complete" | "partial";
  agentRemoved: boolean;
  error?: { code: string; message: string };
  warnings?: string[];
};

export async function planOfficialClawUpdate(
  client: GatewayBrowserClient,
  agentId: string,
  currentVersion: string,
  source: ClawCatalogSource,
): Promise<ClawUpdatePlan> {
  const plan = await client.request<ClawUpdatePlan>("claws.update.plan", { agentId, source });
  if (
    plan.operation !== "update" ||
    plan.target.agentId !== agentId ||
    plan.target.currentVersion !== currentVersion ||
    plan.target.targetVersion !== source.version
  ) {
    throw new Error("The Claw update plan no longer matches this agent and release.");
  }
  return plan;
}

export async function applyOfficialClawUpdate(
  client: GatewayBrowserClient,
  agentId: string,
  source: ClawCatalogSource,
  plan: ClawUpdatePlan,
  acknowledgeClawHubRisk: boolean,
  acknowledgeCapabilities: ClawPluginAcknowledgement[],
  acknowledgeSkillWarnings: ClawSkillAcknowledgement[],
): Promise<ClawUpdateResult> {
  const result = await client.request<ClawUpdateResult>("claws.update.apply", {
    agentId,
    source,
    planIntegrity: plan.planIntegrity,
    ...(plan.riskAcknowledgementRequired ? { acknowledgeClawHubRisk } : {}),
    ...(acknowledgeCapabilities.length ? { acknowledgeCapabilities } : {}),
    ...(acknowledgeSkillWarnings.length ? { acknowledgeSkillWarnings } : {}),
  });
  if (result.agentId !== agentId) {
    throw new Error("The Claw update result targets a different agent.");
  }
  return result;
}

export async function planClawRemoval(
  client: GatewayBrowserClient,
  agentId: string,
): Promise<ClawLifecyclePlan> {
  const plan = await client.request<ClawLifecyclePlan>("claws.remove.plan", { agentId });
  if (plan.operation !== "remove" || plan.target.agentId !== agentId) {
    throw new Error("The Claw removal plan targets a different agent.");
  }
  if (plan.riskAcknowledgementRequired) {
    throw new Error("The Claw removal plan unexpectedly requires package trust consent.");
  }
  return plan;
}

export async function applyClawRemoval(
  client: GatewayBrowserClient,
  agentId: string,
  plan: ClawLifecyclePlan,
): Promise<ClawRemoveResult> {
  const result = await client.request<ClawRemoveResult>("claws.remove.apply", {
    agentId,
    planIntegrity: plan.planIntegrity,
  });
  if (result.agentId !== agentId) {
    throw new Error("The Claw removal result targets a different agent.");
  }
  return result;
}
