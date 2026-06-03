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
import type { MetaPlan, MetaRunStatus } from "./types.js";

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

export type MetaRunStepSkippedResult = {
  status: "skipped";
  output: MetaStepOutput;
  error: string;
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
};

class MetaPauseSentinelError extends Error {}

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

function buildRecursionGuardFailure(planName: string): MetaRunResult {
  return {
    status: "failed",
    finalText: `Meta plan "${planName}" is already active; refusing recursive re-entry.`,
    outputs: {},
    steps: {},
  };
}

export async function runMetaPlan(options: RunMetaPlanOptions): Promise<MetaRunResult> {
  if (options.activeMetaNames?.includes(options.plan.name)) {
    return buildRecursionGuardFailure(options.plan.name);
  }

  const outputs: Record<string, MetaStepOutput> = {};
  const steps: Record<string, MetaRunStepResult> = {};

  for (const step of options.plan.steps) {
    const executor = options.executors[step.kind];
    if (!executor) {
      return {
        status: "failed",
        finalText: `No executor registered for meta step kind "${step.kind}" on step "${step.id}".`,
        outputs,
        steps,
      };
    }

    try {
      const renderContext = buildRenderContext(options.input, outputs);
      const renderedPrompt = renderMetaTemplate(step.prompt, renderContext);
      const renderedArgs = renderMetaTemplateArgs(step.args, renderContext);
      const executionResult = await executor({
        step,
        renderedPrompt,
        renderedArgs,
        input: options.input,
        outputs,
      });
      const pauseOutput = asPauseOutput(executionResult, step.id);
      if (pauseOutput) {
        if (step.kind !== "user_input") {
          throw new MetaPauseSentinelError(
            `Meta step "${step.id}" returned a pause sentinel, but only "user_input" steps may pause.`,
          );
        }
        outputs[step.id] = pauseOutput;
        steps[step.id] = {
          status: "paused",
          output: pauseOutput,
        };
        return {
          status: "paused",
          finalText: buildPauseFinalText(options.plan, step.id, pauseOutput),
          outputs,
          steps,
        };
      }

      const output = asRecordOutput(executionResult, step.id);
      outputs[step.id] = output;
      steps[step.id] = {
        status: "succeeded",
        output,
      };
    } catch (error) {
      const message = formatErrorMessage(error);
      if (error instanceof MetaPauseSentinelError) {
        steps[step.id] = {
          status: "failed",
          error: message,
        };
        return {
          status: "failed",
          finalText: `Meta step "${step.id}" failed: ${message}`,
          outputs,
          steps,
        };
      }
      if (step.onFailure.kind === "skip") {
        outputs[step.id] = {};
        steps[step.id] = {
          status: "skipped",
          output: {},
          error: message,
        };
        continue;
      }
      if (step.onFailure.kind === "substitute") {
        outputs[step.id] = step.onFailure.output;
        steps[step.id] = {
          status: "succeeded",
          recovery: "substitute",
          output: step.onFailure.output,
          error: message,
        };
        continue;
      }
      steps[step.id] = {
        status: "failed",
        error: message,
      };
      return {
        status: "failed",
        finalText: `Meta step "${step.id}" failed: ${message}`,
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
