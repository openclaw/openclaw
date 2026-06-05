import { validateJsonSchemaValue, type JsonSchemaValue } from "../../plugins/schema-validator.js";
import type { SkillSnapshot } from "../types.js";
import {
  findDeterministicMetaTriggerMatch,
  type MetaSkillCatalog,
  type MetaTriggerMatch,
} from "./catalog.js";
import type { MetaExecutorRegistry, MetaPauseOutput, MetaStepContext } from "./executors.js";
import { META_PAUSE_KEY } from "./executors.js";
import { runMetaPlan as runMetaPlanWithExecutors } from "./runner.js";
import type { MetaRunResult, RunMetaPlanOptions } from "./runner.js";
import { isPlainRecord } from "./template.js";
import type { MetaStep, MetaStepKind } from "./types.js";

export type RuntimeMetaInvokePlanRunnerOptions = Pick<RunMetaPlanOptions, "plan" | "input"> & {
  parentToolCallId?: string;
};

export type RuntimeMetaInvokePlanRunner = (
  options: RuntimeMetaInvokePlanRunnerOptions,
) => Promise<MetaRunResult>;

export type TriggeredMetaRunResult = {
  match: MetaTriggerMatch;
  result: MetaRunResult;
};

type RuntimeMetaSkillCatalog = NonNullable<SkillSnapshot["metaSkillCatalog"]>;
type DefaultMetaInvokeRuntimeOptions = {
  runMetaPlan?: RuntimeMetaInvokePlanRunner;
  stepKinds?: readonly MetaStepKind[];
};
const DEFAULT_RUNTIME_STEP_KINDS: readonly MetaStepKind[] = ["user_input"];
const META_RUN_INPUT_CONTEXT_KEY = "_meta";

function buildUserInputPauseOutput(
  options: Pick<MetaStepContext, "step" | "renderedArgs">,
): MetaPauseOutput {
  const output: MetaPauseOutput = {
    [META_PAUSE_KEY]: true,
  };
  if (options.step.schema) {
    output.schema = options.step.schema;
  }
  if (isPlainRecord(options.renderedArgs) && Object.keys(options.renderedArgs).length > 0) {
    output.prefill = options.renderedArgs;
  }
  return output;
}

function buildUserInputPrefill(
  context: Pick<MetaStepContext, "renderedArgs" | "input">,
): Record<string, unknown> {
  const renderedArgs = isPlainRecord(context.renderedArgs) ? context.renderedArgs : {};
  const {
    [META_PAUSE_KEY]: _reserved,
    [META_RUN_INPUT_CONTEXT_KEY]: _meta,
    ...input
  } = context.input;
  return {
    ...renderedArgs,
    ...input,
  };
}

function resolveUserInputOutput(context: MetaStepContext): Record<string, unknown> | undefined {
  if (Object.hasOwn(context.input, META_PAUSE_KEY)) {
    return undefined;
  }
  const { [META_RUN_INPUT_CONTEXT_KEY]: _meta, ...userInput } = context.input;

  if (!context.step.schema) {
    return Object.keys(userInput).length > 0 ? userInput : undefined;
  }

  const validation = validateJsonSchemaValue({
    schema: context.step.schema as JsonSchemaValue,
    cacheKey: `meta-user-input:${context.step.id}`,
    cache: false,
    value: userInput,
  });
  return validation.ok && isPlainRecord(validation.value) ? validation.value : undefined;
}

const DEFAULT_META_EXECUTORS = {
  user_input: (context) => {
    const output = resolveUserInputOutput(context);
    if (output) {
      return output;
    }
    return buildUserInputPauseOutput({
      step: context.step,
      renderedArgs: buildUserInputPrefill(context),
    });
  },
} satisfies MetaExecutorRegistry;

export function createDefaultMetaExecutorRegistry(
  executors: MetaExecutorRegistry = {},
): MetaExecutorRegistry {
  return {
    ...DEFAULT_META_EXECUTORS,
    ...executors,
  };
}

export function createDefaultMetaInvokePlanRunner(
  executors: MetaExecutorRegistry = {},
): RuntimeMetaInvokePlanRunner {
  return async (options) =>
    await runMetaPlanWithExecutors({
      plan: options.plan,
      input: options.input,
      executors: createDefaultMetaExecutorRegistry(executors),
    });
}

export const defaultMetaInvokePlanRunner = createDefaultMetaInvokePlanRunner();

export async function runTriggeredMetaPlan(options: {
  catalog: MetaSkillCatalog;
  inputText: string;
  input: Record<string, unknown>;
  runMetaPlan: RuntimeMetaInvokePlanRunner;
  parentToolCallId?: string;
}): Promise<TriggeredMetaRunResult | undefined> {
  const match = findDeterministicMetaTriggerMatch(options.catalog, options.inputText);
  if (!match) {
    return undefined;
  }
  const result = await options.runMetaPlan({
    plan: match.plan,
    input: options.input,
    ...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
  });
  return {
    match,
    result,
  };
}

function isDefaultRunnableStep(step: MetaStep, stepKinds: ReadonlySet<MetaStepKind>): boolean {
  if (!stepKinds.has(step.kind)) {
    return false;
  }
  if (step.kind === "tool_call") {
    return typeof step.toolName === "string" && step.toolName.trim().length > 0;
  }
  return true;
}

function hasDefaultSafeUserInputShape(plan: { steps: MetaStep[] }): boolean {
  const userInputSteps = plan.steps.filter((step) => step.kind === "user_input");
  return userInputSteps.length <= 1 && userInputSteps.every((step) => step.dependsOn.length === 0);
}

function filterDefaultRunnableCatalog(catalog: RuntimeMetaSkillCatalog, stepKinds: MetaStepKind[]) {
  const runnableKinds = new Set(stepKinds);
  return {
    ...catalog,
    plans: catalog.plans.filter(
      (plan) =>
        hasDefaultSafeUserInputShape(plan) &&
        plan.steps.every((step) => isDefaultRunnableStep(step, runnableKinds)),
    ),
  };
}

export function resolveMetaInvokeRuntime(
  snapshot: SkillSnapshot | undefined,
  runMetaPlan: RuntimeMetaInvokePlanRunner | undefined,
  defaultRuntimeOptions?: DefaultMetaInvokeRuntimeOptions,
):
  | {
      metaSkillCatalog: RuntimeMetaSkillCatalog;
      runMetaPlan: RuntimeMetaInvokePlanRunner;
    }
  | undefined {
  const metaSkillCatalog = snapshot?.metaSkillCatalog;
  if (!metaSkillCatalog || metaSkillCatalog.plans.length === 0) {
    return undefined;
  }
  if (runMetaPlan) {
    return {
      metaSkillCatalog,
      runMetaPlan,
    };
  }

  const defaultRunnableCatalog = filterDefaultRunnableCatalog(metaSkillCatalog, [
    ...(defaultRuntimeOptions?.stepKinds ?? DEFAULT_RUNTIME_STEP_KINDS),
  ]);
  if (defaultRunnableCatalog.plans.length === 0) {
    return undefined;
  }
  return {
    metaSkillCatalog: defaultRunnableCatalog,
    runMetaPlan: defaultRuntimeOptions?.runMetaPlan ?? defaultMetaInvokePlanRunner,
  };
}
