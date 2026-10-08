import type { RuntimeEnv } from "../runtime.js";
import type { SystemAgentAssistantPlan, SystemAgentAssistantPlanner } from "./assistant.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import { isInvalidConfigSetOperation } from "./operations-internal.js";
import {
  describeSystemAgentPersistentOperation,
  parseSystemAgentOperation,
  type SystemAgentOperation,
} from "./operations.js";
import { loadSystemAgentOverview } from "./overview.js";
import {
  resolveSystemAgentVerifiedInferenceRoute,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

type SystemAgentDialogueOptions = {
  loadOverview?: typeof loadSystemAgentOverview;
  planWithAssistant?: SystemAgentAssistantPlanner;
  deps?: SystemAgentVerifiedInferenceDeps;
  readonly verifiedInference: SystemAgentVerifiedInferenceBinding;
};

export function approvalQuestion(operation: SystemAgentOperation): string {
  return `Apply this operation: ${describeSystemAgentPersistentOperation(operation)}?`;
}

export async function resolveSystemAgentOperation(
  input: string,
  runtime: RuntimeEnv,
  opts: SystemAgentDialogueOptions,
): Promise<SystemAgentOperation> {
  if (!opts.verifiedInference) {
    throw new SystemAgentInferenceUnavailableError("conversation");
  }
  const operation = parseSystemAgentOperation(input);
  const trimmed = input.trim().toLowerCase();
  // Direct commands and invalid config writes must never enter the assistant planner.
  if (
    operation.kind !== "none" ||
    isInvalidConfigSetOperation(operation) ||
    !trimmed ||
    trimmed === "quit" ||
    trimmed === "exit"
  ) {
    return operation;
  }
  const overview = await (opts.loadOverview ?? loadSystemAgentOverview)();
  const planner = opts.planWithAssistant ?? (await import("./assistant.js")).planSystemAgentCommand;
  let plan: SystemAgentAssistantPlan | null;
  try {
    plan = await planner({
      input,
      overview,
      verifiedInference: opts.verifiedInference,
    });
    if (
      plan &&
      !(await resolveSystemAgentVerifiedInferenceRoute(opts.verifiedInference, opts.deps))
    ) {
      throw new SystemAgentInferenceUnavailableError("planner", [], "route-changed");
    }
  } catch (error) {
    if (error instanceof SystemAgentInferenceUnavailableError) {
      throw error;
    }
    throw new SystemAgentInferenceUnavailableError("planner", [error]);
  }
  if (!plan) {
    throw new SystemAgentInferenceUnavailableError("planner");
  }
  if (!plan.command) {
    if (!plan.reply?.trim()) {
      throw new SystemAgentInferenceUnavailableError("planner");
    }
    runtime.log(plan.reply);
    return { kind: "none", message: "" };
  }
  const planned = parseSystemAgentOperation(plan.command);
  if (planned.kind === "none") {
    throw new SystemAgentInferenceUnavailableError("planner");
  }
  // Assistant plans are echoed before execution so the user can see the interpreted command.
  const modelLabel = plan.modelLabel ?? overview.defaultModel ?? "configured model";
  runtime.log(`[openclaw] planner: ${modelLabel}`);
  if (plan.reply) {
    runtime.log(plan.reply);
  }
  runtime.log(`[openclaw] interpreted: ${plan.command}`);
  return planned;
}
