import { formatErrorMessage } from "../../infra/errors.js";
import {
  isMetaPauseOutput,
  META_PAUSE_KEY,
  type MetaExecutorRegistry,
  type MetaPauseOutput,
  type MetaRunInput,
  type MetaStepOutput,
} from "./executors.js";
import { isPlainRecord, renderMetaTemplate, renderMetaTemplateArgs } from "./template.js";
import type {
  MetaFailureAttempt,
  MetaPlan,
  MetaRouteCases,
  MetaRunStatus,
  MetaWhenExpression,
} from "./types.js";

export type MetaRunStepSucceededResult = {
  status: "succeeded";
  output: MetaStepOutput;
};

export type MetaRunStepSubstitutedResult = {
  status: "succeeded";
  recovery: "substitute";
  output: MetaStepOutput;
  error: string;
};

export type MetaRunStepFailoverResult = {
  status: "succeeded";
  recovery: "failover";
  output: MetaStepOutput;
  error: string;
  failoverAttempt: number;
};

export type MetaRunStepSkippedResult = {
  status: "skipped";
  output: MetaStepOutput;
  error?: string;
  reason?: string;
};

export type MetaRunStepFailedResult = {
  status: "failed";
  error: string;
};

export type MetaRunStepPausedResult = {
  status: "paused";
  output?: MetaStepOutput;
  error?: string;
};

export type MetaRunStepResult =
  | MetaRunStepSucceededResult
  | MetaRunStepSubstitutedResult
  | MetaRunStepFailoverResult
  | MetaRunStepSkippedResult
  | MetaRunStepFailedResult
  | MetaRunStepPausedResult;

export type MetaRunResult = {
  status: Extract<MetaRunStatus, "succeeded" | "failed" | "paused">;
  finalText: string;
  outputs: Record<string, MetaStepOutput>;
  steps: Record<string, MetaRunStepResult>;
};

export type RunMetaPlanOptions = {
  plan: MetaPlan;
  input: MetaRunInput;
  executors: MetaExecutorRegistry;
  activeMetaNames?: readonly string[];
  onStepStarted?: (params: {
    step: MetaPlan["steps"][number];
    inputJson: Record<string, unknown>;
  }) => void | Promise<void>;
  resume?: {
    startAtStepId: string;
    priorOutputs: Record<string, MetaStepOutput>;
  };
};

class MetaPauseSentinelError extends Error {}

type MetaStepExecutionOutcome =
  | {
      kind: "completed";
      stepId: string;
      output: MetaStepOutput;
      stepResult: MetaRunStepResult;
    }
  | {
      kind: "terminal";
      stepId: string;
      status: Extract<MetaRunResult["status"], "failed" | "paused">;
      finalText: string;
      output?: MetaStepOutput;
      stepResult?: MetaRunStepResult;
    };

function asRecordOutput(value: unknown, stepId: string): MetaStepOutput {
  if (!isPlainRecord(value)) {
    throw new Error(`Meta step ${stepId} returned a non-record output`);
  }
  return value;
}

function asPauseOutput(value: unknown, stepId: string): MetaPauseOutput | null {
  if (!isPlainRecord(value) || value[META_PAUSE_KEY] !== true) {
    return null;
  }
  if (!isMetaPauseOutput(value)) {
    throw new MetaPauseSentinelError(`Meta step ${stepId} returned an invalid pause sentinel`);
  }
  return value;
}

function formatPauseSchema(
  output: MetaPauseOutput,
  stepSchema: Record<string, unknown> | undefined,
): string {
  const schema = output.schema ?? stepSchema;
  if (!schema) {
    return "Awaiting user input.";
  }

  const requiredFields = Array.isArray(schema.required)
    ? schema.required.filter((field): field is string => typeof field === "string")
    : [];
  if (requiredFields.length > 0) {
    return `Awaiting user input for ${requiredFields.join(", ")}.`;
  }

  return `Awaiting user input with schema ${JSON.stringify(schema)}.`;
}

function buildPauseFinalText(plan: MetaPlan, stepId: string, output: MetaPauseOutput): string {
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  const schemaText = formatPauseSchema(output, step?.schema);
  return `Meta plan "${plan.name}" paused on step "${stepId}". ${schemaText}`;
}

function buildFinalFallback(
  output: MetaStepOutput | undefined,
  steps: Record<string, MetaRunStepResult>,
): string {
  return JSON.stringify({
    output: output ?? {},
    steps,
  });
}

function resolveFinalText(
  plan: MetaPlan,
  outputs: Record<string, MetaStepOutput>,
  steps: Record<string, MetaRunStepResult>,
): string {
  if (plan.finalTextMode.kind === "raw") {
    return JSON.stringify({ outputs, steps });
  }

  const selectedStepId =
    plan.finalTextMode.kind === "step" ? plan.finalTextMode.stepId : plan.steps.at(-1)?.id;
  const selectedOutput = selectedStepId ? outputs[selectedStepId] : undefined;
  const selectedText = selectedOutput?.text;
  if (typeof selectedText === "string") {
    return selectedText;
  }
  if (
    plan.finalTextMode.kind === "step" &&
    selectedStepId &&
    steps[selectedStepId]?.status === "skipped"
  ) {
    const selectedIndex = plan.steps.findIndex((step) => step.id === selectedStepId);
    for (const step of plan.steps.slice(0, selectedIndex).toReversed()) {
      const fallbackText = outputs[step.id]?.text;
      if (typeof fallbackText === "string") {
        return fallbackText;
      }
    }
  }
  return buildFinalFallback(selectedOutput, steps);
}

function buildRenderContext(
  input: MetaRunInput,
  outputs: Record<string, MetaStepOutput>,
): Record<string, unknown> {
  return {
    input,
    ...outputs,
  };
}

function buildRenderedStepInputJson(params: {
  renderedPrompt: string;
  renderedArgs: unknown;
}): Record<string, unknown> {
  const inputJson: Record<string, unknown> = {};
  if (params.renderedPrompt.trim()) {
    inputJson.prompt = params.renderedPrompt;
  }
  if (params.renderedArgs !== undefined) {
    inputJson.args = params.renderedArgs;
  }
  return inputJson;
}

function readContextPath(context: Record<string, unknown>, path: string): unknown {
  let current: unknown = context;
  for (const segment of path.split(".")) {
    if (!current || (typeof current !== "object" && typeof current !== "function")) {
      return undefined;
    }
    if (!Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function isTruthyWhenValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function evaluateWhenExpression(
  expression: MetaWhenExpression,
  context: Record<string, unknown>,
): boolean {
  const value = readContextPath(context, expression.path);
  if (expression.kind === "truthy") {
    return isTruthyWhenValue(value);
  }
  if (expression.kind === "equals") {
    return jsonEqual(value, expression.value);
  }
  if (expression.kind === "not_equals") {
    return !jsonEqual(value, expression.value);
  }
  return expression.values.some((candidate) => jsonEqual(value, candidate));
}

function normalizeRouteValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function collectRouteTargets(route: MetaRouteCases): Set<string> {
  return new Set([...Object.values(route.cases).flat(), ...(route.default ?? [])]);
}

function resolveSelectedRouteTargets(route: MetaRouteCases, output: MetaStepOutput): Set<string> {
  const value = normalizeRouteValue(readContextPath(output, route.path));
  const selectedTargets = value === undefined ? undefined : route.cases[value];
  return new Set(selectedTargets ?? route.default ?? []);
}

function applyRouteOutcome(
  step: MetaPlan["steps"][number],
  output: MetaStepOutput,
  disabledByRoute: Map<string, string>,
): void {
  if (!step.route) {
    return;
  }
  const allTargets = collectRouteTargets(step.route);
  const selectedTargets = resolveSelectedRouteTargets(step.route, output);
  for (const targetId of allTargets) {
    if (selectedTargets.has(targetId)) {
      disabledByRoute.delete(targetId);
      continue;
    }
    disabledByRoute.set(targetId, `route case not selected by ${step.id}.${step.route.path}`);
  }
}

function buildWhenSkippedStepResult(expression: MetaWhenExpression): MetaRunStepSkippedResult {
  return {
    status: "skipped",
    output: {},
    reason: `when expression did not match: ${expression.path}`,
  };
}

function buildRouteSkippedStepResult(reason: string): MetaRunStepSkippedResult {
  return {
    status: "skipped",
    output: {},
    reason,
  };
}

function buildRecursionGuardFailure(planName: string): MetaRunResult {
  return {
    status: "failed",
    finalText: `Meta plan "${planName}" is already active; refusing recursive re-entry.`,
    outputs: {},
    steps: {},
  };
}

function applyFailureAttempt(
  step: MetaPlan["steps"][number],
  attempt: MetaFailureAttempt,
): MetaPlan["steps"][number] {
  return {
    ...step,
    ...(attempt.prompt === undefined ? {} : { prompt: attempt.prompt }),
    ...(attempt.toolName === undefined ? {} : { toolName: attempt.toolName }),
    ...(attempt.skillName === undefined ? {} : { skillName: attempt.skillName }),
    ...(attempt.args === undefined ? {} : { args: attempt.args }),
    ...(attempt.choices === undefined ? {} : { choices: attempt.choices }),
    ...(attempt.schema === undefined ? {} : { schema: attempt.schema }),
    onFailure: { kind: "fail" },
  };
}

function buildFailureText(stepId: string, message: string): string {
  return `Meta step "${stepId}" failed: ${message}`;
}

function buildFailoverError(primaryError: string, attemptErrors: readonly string[]): string {
  if (attemptErrors.length === 0) {
    return primaryError;
  }
  return [
    primaryError,
    ...attemptErrors.map((message, index) => `failover ${index + 1}: ${message}`),
  ].join("; ");
}

async function executeRenderedMetaStep(
  options: Pick<RunMetaPlanOptions, "executors" | "input" | "plan">,
  step: MetaPlan["steps"][number],
  renderedPrompt: string,
  renderedArgs: unknown,
  outputSnapshot: Record<string, MetaStepOutput>,
): Promise<MetaStepExecutionOutcome> {
  const executor = options.executors[step.kind];
  if (!executor) {
    return {
      kind: "terminal",
      stepId: step.id,
      status: "failed",
      finalText: `No executor registered for meta step kind "${step.kind}" on step "${step.id}".`,
    };
  }
  const executionResult = await executor({
    step,
    renderedPrompt,
    renderedArgs,
    input: options.input,
    outputs: outputSnapshot,
  });
  const pauseOutput = asPauseOutput(executionResult, step.id);
  if (pauseOutput) {
    if (step.kind !== "user_input") {
      throw new MetaPauseSentinelError(
        `Meta step "${step.id}" returned a pause sentinel, but only "user_input" steps may pause.`,
      );
    }
    return {
      kind: "terminal",
      stepId: step.id,
      status: "paused",
      finalText: buildPauseFinalText(options.plan, step.id, pauseOutput),
      output: pauseOutput,
      stepResult: {
        status: "paused",
        output: pauseOutput,
      },
    };
  }

  const output = asRecordOutput(executionResult, step.id);
  return {
    kind: "completed",
    stepId: step.id,
    output,
    stepResult: {
      status: "succeeded",
      output,
    },
  };
}

async function renderAndExecuteMetaStep(
  options: Pick<RunMetaPlanOptions, "executors" | "input" | "onStepStarted" | "plan">,
  step: MetaPlan["steps"][number],
  outputSnapshot: Record<string, MetaStepOutput>,
): Promise<MetaStepExecutionOutcome> {
  const renderContext = buildRenderContext(options.input, outputSnapshot);
  const renderedPrompt = renderMetaTemplate(step.prompt, renderContext);
  const renderedArgs = renderMetaTemplateArgs(step.args, renderContext);
  if (options.onStepStarted) {
    await options.onStepStarted({
      step,
      inputJson: buildRenderedStepInputJson({ renderedPrompt, renderedArgs }),
    });
  }
  return await executeRenderedMetaStep(options, step, renderedPrompt, renderedArgs, outputSnapshot);
}

async function recoverFailedMetaStep(
  options: Pick<RunMetaPlanOptions, "executors" | "input" | "onStepStarted" | "plan">,
  step: MetaPlan["steps"][number],
  outputSnapshot: Record<string, MetaStepOutput>,
  error: unknown,
): Promise<MetaStepExecutionOutcome> {
  const message = formatErrorMessage(error);
  if (error instanceof MetaPauseSentinelError) {
    return {
      kind: "terminal",
      stepId: step.id,
      status: "failed",
      finalText: buildFailureText(step.id, message),
      stepResult: {
        status: "failed",
        error: message,
      },
    };
  }
  if (step.onFailure.kind === "skip") {
    return {
      kind: "completed",
      stepId: step.id,
      output: {},
      stepResult: {
        status: "skipped",
        output: {},
        error: message,
      },
    };
  }
  if (step.onFailure.kind === "substitute") {
    return {
      kind: "completed",
      stepId: step.id,
      output: step.onFailure.output,
      stepResult: {
        status: "succeeded",
        recovery: "substitute",
        output: step.onFailure.output,
        error: message,
      },
    };
  }
  if (step.onFailure.kind === "failover") {
    const attemptErrors: string[] = [];
    for (const [index, attempt] of step.onFailure.attempts
      .slice(0, step.onFailure.maxAttempts)
      .entries()) {
      try {
        const outcome = await renderAndExecuteMetaStep(
          options,
          applyFailureAttempt(step, attempt),
          outputSnapshot,
        );
        if (outcome.kind === "completed" && outcome.stepResult.status === "succeeded") {
          return {
            ...outcome,
            stepResult: {
              status: "succeeded",
              recovery: "failover",
              output: outcome.output,
              error: buildFailoverError(message, attemptErrors),
              failoverAttempt: index + 1,
            },
          };
        }
        if (outcome.kind === "terminal") {
          return outcome;
        }
        return outcome;
      } catch (attemptError) {
        attemptErrors.push(formatErrorMessage(attemptError));
      }
    }
    return {
      kind: "terminal",
      stepId: step.id,
      status: "failed",
      finalText: buildFailureText(step.id, buildFailoverError(message, attemptErrors)),
      stepResult: {
        status: "failed",
        error: buildFailoverError(message, attemptErrors),
      },
    };
  }
  return {
    kind: "terminal",
    stepId: step.id,
    status: "failed",
    finalText: buildFailureText(step.id, message),
    stepResult: {
      status: "failed",
      error: message,
    },
  };
}

async function executeMetaStep(
  options: Pick<RunMetaPlanOptions, "executors" | "input" | "onStepStarted" | "plan">,
  step: MetaPlan["steps"][number],
  outputSnapshot: Record<string, MetaStepOutput>,
  routeSkipReason?: string,
): Promise<MetaStepExecutionOutcome> {
  try {
    if (routeSkipReason) {
      return {
        kind: "completed",
        stepId: step.id,
        output: {},
        stepResult: buildRouteSkippedStepResult(routeSkipReason),
      };
    }
    const renderContext = buildRenderContext(options.input, outputSnapshot);
    if (step.when && !evaluateWhenExpression(step.when, renderContext)) {
      return {
        kind: "completed",
        stepId: step.id,
        output: {},
        stepResult: buildWhenSkippedStepResult(step.when),
      };
    }
    return await renderAndExecuteMetaStep(options, step, outputSnapshot);
  } catch (error) {
    return await recoverFailedMetaStep(options, step, outputSnapshot, error);
  }
}

function resolveRunnableSteps(
  plan: MetaPlan,
  resume: RunMetaPlanOptions["resume"],
): MetaPlan["steps"] {
  if (!resume) {
    return plan.steps;
  }
  const startIndex = plan.steps.findIndex((step) => step.id === resume.startAtStepId);
  return startIndex === -1 ? [] : plan.steps.slice(startIndex);
}

function findReadySteps(
  pending: ReadonlySet<string>,
  runnableSteps: MetaPlan["steps"],
  completedStepIds: ReadonlySet<string>,
): MetaPlan["steps"] {
  return runnableSteps.filter(
    (step) =>
      pending.has(step.id) &&
      step.dependsOn.every((dependencyId) => completedStepIds.has(dependencyId)),
  );
}

function buildUnrunnableFailure(
  planName: string,
  pending: ReadonlySet<string>,
  runnableSteps: MetaPlan["steps"],
): string {
  const pendingSteps = runnableSteps
    .filter((step) => pending.has(step.id))
    .map((step) => `${step.id} depends on [${step.dependsOn.join(", ")}]`)
    .join("; ");
  return `Meta plan "${planName}" has no runnable steps. Unresolved dependencies: ${pendingSteps}`;
}

export async function runMetaPlan(options: RunMetaPlanOptions): Promise<MetaRunResult> {
  if (options.activeMetaNames?.includes(options.plan.name)) {
    return buildRecursionGuardFailure(options.plan.name);
  }

  const outputs: Record<string, MetaStepOutput> = { ...options.resume?.priorOutputs };
  const steps: Record<string, MetaRunStepResult> = {};
  if (
    options.resume &&
    !options.plan.steps.some((candidate) => candidate.id === options.resume?.startAtStepId)
  ) {
    return {
      status: "failed",
      finalText: `Meta plan "${options.plan.name}" cannot resume from unknown step "${options.resume.startAtStepId}".`,
      outputs,
      steps,
    };
  }

  const runnableSteps = resolveRunnableSteps(options.plan, options.resume);
  const stepsById = new Map(options.plan.steps.map((step) => [step.id, step]));
  const pendingStepIds = new Set(runnableSteps.map((step) => step.id));
  const completedStepIds = new Set(Object.keys(outputs));
  const disabledByRoute = new Map<string, string>();

  while (pendingStepIds.size > 0) {
    const readySteps = findReadySteps(pendingStepIds, runnableSteps, completedStepIds);
    if (readySteps.length === 0) {
      return {
        status: "failed",
        finalText: buildUnrunnableFailure(options.plan.name, pendingStepIds, runnableSteps),
        outputs,
        steps,
      };
    }

    const outputSnapshot = { ...outputs };
    const outcomes = await Promise.all(
      readySteps.map((step) =>
        executeMetaStep(options, step, outputSnapshot, disabledByRoute.get(step.id)),
      ),
    );
    let terminalOutcome: Extract<MetaStepExecutionOutcome, { kind: "terminal" }> | undefined;
    for (const outcome of outcomes) {
      pendingStepIds.delete(outcome.stepId);
      if (outcome.kind === "completed") {
        outputs[outcome.stepId] = outcome.output;
        steps[outcome.stepId] = outcome.stepResult;
        completedStepIds.add(outcome.stepId);
        const completedStep = stepsById.get(outcome.stepId);
        if (completedStep && outcome.stepResult.status === "succeeded") {
          applyRouteOutcome(completedStep, outcome.output, disabledByRoute);
        }
        continue;
      }
      if (outcome.output) {
        outputs[outcome.stepId] = outcome.output;
      }
      if (outcome.stepResult) {
        steps[outcome.stepId] = outcome.stepResult;
      }
      terminalOutcome ??= outcome;
    }
    if (terminalOutcome) {
      return {
        status: terminalOutcome.status,
        finalText: terminalOutcome.finalText,
        outputs,
        steps,
      };
    }
  }

  return {
    status: "succeeded",
    finalText: resolveFinalText(options.plan, outputs, steps),
    outputs,
    steps,
  };
}
