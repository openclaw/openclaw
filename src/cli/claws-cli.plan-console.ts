// Console rendering for the Claw add-plan summary an operator consents to.
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { ClawRemovePlan } from "../claws/lifecycle-remove-contract.js";
import type { ClawAddPlan } from "../claws/types.js";
import { redactSensitiveArgv } from "../config/redact-argv.js";
import { redactSensitiveText } from "../logging/redact.js";
import type { RuntimeEnv } from "../runtime.js";
import { logClawAgentConfiguration } from "./claws-cli-output.js";

export function logClawAddPlanSummary(plan: ClawAddPlan, runtime: RuntimeEnv): void {
  runtime.log(`Agent: ${plan.agent.finalId}`);
  runtime.log(`Workspace: ${plan.agent.workspace}`);
  logClawAgentConfiguration(plan, runtime);
  runtime.log(`Actions: ${plan.summary.totalActions}`);
  runtime.log(`Packages: ${plan.summary.packageActions}`);
  for (const action of plan.actions.filter((candidate) => candidate.kind === "package")) {
    const requirementState =
      typeof action.details?.requirementState === "string"
        ? action.details.requirementState
        : "unresolved";
    runtime.log(
      `  Requirement ${action.target}: ${requirementState}${action.action === "install" ? " (installation requires this exact plan consent)" : ""}`,
    );
  }
  runtime.log(`MCP servers: ${plan.summary.mcpServerActions}`);
  for (const action of plan.actions.filter((candidate) => candidate.kind === "mcpServer")) {
    const server = asOptionalRecord(action.details);
    const target =
      typeof server?.url === "string"
        ? redactSensitiveUrlLikeString(server.url)
        : typeof server?.command === "string"
          ? redactSensitiveArgv([
              server.command,
              ...(Array.isArray(server.args)
                ? server.args.filter((arg): arg is string => typeof arg === "string")
                : []),
            ]).join(" ")
          : "invalid declaration";
    runtime.log(`  MCP ${action.id}: ${target}`);
  }
  runtime.log(`Cron jobs: ${plan.summary.cronJobActions}`);
  if (plan.capabilityChanges.length > 0) {
    runtime.log(`Capability escalations (${plan.capabilityChanges.length}):`);
    for (const change of plan.capabilityChanges) {
      runtime.log(
        redactSensitiveText(`  ! ${change.kind}:${change.id} ${JSON.stringify(change.effect)}`),
      );
    }
    runtime.log("The plan integrity binds every capability line above.");
  }
  if (plan.summary.blockedActions > 0) {
    runtime.log(`Blocked actions: ${plan.summary.blockedActions}`);
  }
}

export function logClawRemovePlanSummary(plan: ClawRemovePlan, runtime: RuntimeEnv): void {
  runtime.log(`Remove actions: ${plan.actions.length}`);
  runtime.log(`Plan integrity: ${plan.planIntegrity}`);
  for (const action of plan.actions) {
    const serializedValue =
      action.action === "set" && action.details && "value" in action.details
        ? JSON.stringify(action.details.value)
        : undefined;
    const value = serializedValue === undefined ? "" : `; value=${serializedValue}`;
    const status = action.blocked ? "blocked" : "ready";
    const reason = action.reason ? `; reason=${action.reason}` : "";
    runtime.log(
      redactSensitiveText(
        `  ${action.kind} ${action.target}: ${action.action}; status=${status}${value}${reason}`,
      ),
    );
  }
}
