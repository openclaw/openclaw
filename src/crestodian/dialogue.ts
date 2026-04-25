import type { RuntimeEnv } from "../runtime.js";
import {
  planCrestodianCommand,
  type CrestodianAssistantPlan,
  type CrestodianAssistantPlanner,
} from "./assistant.js";
import {
  describeCrestodianPersistentOperation,
  parseCrestodianOperation,
  type CrestodianOperation,
} from "./operations.js";
import { loadCrestodianOverview, type CrestodianOverview } from "./overview.js";

export type CrestodianDialogueOptions = {
  planWithAssistant?: CrestodianAssistantPlanner;
};

export function approvalQuestion(operation: CrestodianOperation): string {
  return `Apply this operation: ${describeCrestodianPersistentOperation(operation)}?`;
}

export function isYes(input: string): boolean {
  return /^(y|yes|apply|do it|approved?)$/i.test(input.trim());
}

export async function resolveCrestodianOperation(
  input: string,
  runtime: RuntimeEnv,
  opts: CrestodianDialogueOptions,
): Promise<CrestodianOperation> {
  const operation = parseCrestodianOperation(input);
  if (!shouldAskAssistant(input, operation)) {
    return operation;
  }
  const overview = await loadCrestodianOverview();
  const planner = opts.planWithAssistant ?? planCrestodianCommand;
  const plan = await planner({ input, overview });
  if (!plan) {
    return operation;
  }
  const planned = parseCrestodianOperation(plan.command);
  if (planned.kind === "none") {
    return operation;
  }
  logAssistantPlan(runtime, plan, overview);
  return planned;
}

function shouldAskAssistant(input: string, operation: CrestodianOperation): boolean {
  if (operation.kind !== "none") {
    return false;
  }
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || trimmed === "quit" || trimmed === "exit") {
    return false;
  }
  return true;
}

function logAssistantPlan(
  runtime: RuntimeEnv,
  plan: CrestodianAssistantPlan,
  overview: CrestodianOverview,
): void {
  const modelLabel = plan.modelLabel ?? overview.defaultModel ?? "configured model";
  runtime.log(`[crestodian] planner: ${modelLabel}`);
  if (plan.reply) {
    runtime.log(plan.reply);
  }
  runtime.log(`[crestodian] interpreted: ${plan.command}`);
}
