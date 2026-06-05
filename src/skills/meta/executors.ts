import type { MetaStep, MetaStepKind } from "./types.js";

export const META_PAUSE_KEY = "__meta_pause__";

export type MetaRunInput = Record<string, unknown>;
export type MetaStepOutput = Record<string, unknown>;
export type MetaPauseOutput = {
  [META_PAUSE_KEY]: true;
  schema?: Record<string, unknown>;
  prefill?: Record<string, unknown>;
};
export type MetaExecutorResult = MetaStepOutput | MetaPauseOutput;

export type MetaStepContext = {
  step: MetaStep;
  renderedPrompt: string;
  renderedArgs: unknown;
  input: MetaRunInput;
  outputs: Record<string, MetaStepOutput>;
};

export type MetaStepExecutor = (
  context: MetaStepContext,
) => Promise<MetaExecutorResult> | MetaExecutorResult;

export type MetaExecutorRegistry = Partial<Record<MetaStepKind, MetaStepExecutor>>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isMetaPauseOutput(value: unknown): value is MetaPauseOutput {
  if (!isPlainRecord(value) || value[META_PAUSE_KEY] !== true) {
    return false;
  }
  if ("schema" in value && value.schema !== undefined && !isPlainRecord(value.schema)) {
    return false;
  }
  if ("prefill" in value && value.prefill !== undefined && !isPlainRecord(value.prefill)) {
    return false;
  }
  return true;
}
