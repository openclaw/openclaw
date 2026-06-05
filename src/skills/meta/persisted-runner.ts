import { randomUUID } from "node:crypto";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import { isMetaPauseOutput, type MetaRunInput, type MetaStepOutput } from "./executors.js";
import { recordMetaGateEvidence, type MetaGateEvidence, type MetaGateResult } from "./gates.js";
import { runMetaPlan, type MetaRunResult, type MetaRunStepResult } from "./runner.js";
import type { RunMetaPlanOptions } from "./runner.js";
import type { JsonRecord, MetaRunStore } from "./store.js";
import type {
  MetaFinalTextMode,
  MetaPlan,
  MetaRunStatus,
  MetaStep,
  MetaStepStatus,
} from "./types.js";

const DEFAULT_PAUSE_TTL_MS = 24 * 60 * 60 * 1000;
const META_RUN_INPUT_CONTEXT_KEY = "_meta";

export type RunPersistedMetaPlanOptions = RunMetaPlanOptions & {
  store: MetaRunStore;
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  agentRunId?: string;
  channelTargetJson?: JsonRecord;
  workspaceContextJson?: JsonRecord;
  triggerJson?: JsonRecord;
  originalInputSummary?: string;
  finalMode?: string;
  channelBindingJson?: JsonRecord;
  gateResults?: MetaGateResult[];
  gateProposalId?: string;
  deriveGateEvidence?: (params: {
    plan: MetaPlan;
    result: MetaRunResult;
  }) => MetaGateEvidence | undefined;
  nowMs?: () => number;
  createId?: () => string;
  pauseTtlMs?: number;
};

export type PersistedMetaRunResult = MetaRunResult & {
  runId: string;
};

export type ResumePersistedMetaPlanOptions = RunPersistedMetaPlanOptions & {
  sessionKey: string;
};

function toJsonRecord(value: Record<string, unknown> | undefined): JsonRecord | undefined {
  return value;
}

function formatFinalTextMode(mode: MetaFinalTextMode): string {
  if (mode.kind === "step") {
    return `step:${mode.stepId}`;
  }
  return mode.kind;
}

function truncateSummary(value: string): string {
  const normalized = value.trim().replaceAll(/\s+/g, " ");
  if (normalized.length <= 500) {
    return normalized;
  }
  return `${normalized.slice(0, 497)}...`;
}

function summarizeOriginalInput(input: MetaRunInput): string {
  const request = input.request;
  if (typeof request === "string" && request.trim()) {
    return truncateSummary(request);
  }
  return truncateSummary(JSON.stringify(input));
}

function resolveRunCompletedStatus(
  status: MetaRunResult["status"],
): Exclude<MetaRunStatus, "running"> {
  return status;
}

function resolveStepStatus(result: MetaRunStepResult): MetaStepStatus {
  return result.status;
}

function resolveSkillKey(plan: MetaPlan): string {
  return normalizeSkillIndexName(plan.name) || plan.name;
}

function buildDependencyStateJson(
  step: MetaStep,
  state: "pending" | "ready" | MetaStepStatus,
): JsonRecord {
  return {
    dependsOn: step.dependsOn,
    state,
    ...(state === "pending" ? {} : { satisfied: step.dependsOn }),
  };
}

function findStep(plan: MetaPlan, stepId: string): MetaStep {
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) {
    throw new Error(
      `Persisted meta runner could not find step "${stepId}" in plan "${plan.name}".`,
    );
  }
  return step;
}

function mergeResumeInput(params: {
  originalInput: JsonRecord;
  prefillJson: JsonRecord | null;
  resumeInput: MetaRunInput;
}): MetaRunInput {
  return {
    ...params.originalInput,
    ...params.prefillJson,
    ...params.resumeInput,
  };
}

function stripInternalMetaInputContext(input: MetaRunInput): MetaRunInput {
  const { [META_RUN_INPUT_CONTEXT_KEY]: _meta, ...userInput } = input;
  return userInput;
}

function collectPriorOutputs(params: {
  store: MetaRunStore;
  runId: string;
  plan: MetaPlan;
  startAtStepId: string;
}): Record<string, MetaStepOutput> {
  const stepOrder = new Map(params.plan.steps.map((step, index) => [step.id, index]));
  const startIndex = stepOrder.get(params.startAtStepId);
  if (startIndex === undefined) {
    throw new Error(
      `Persisted meta runner could not resume plan "${params.plan.name}" from unknown step "${params.startAtStepId}".`,
    );
  }

  const outputs: Record<string, MetaStepOutput> = {};
  for (const step of params.store.listSteps(params.runId)) {
    const stepIndex = stepOrder.get(step.stepId);
    if (stepIndex === undefined || stepIndex >= startIndex || !step.outputJson) {
      continue;
    }
    if (step.status === "succeeded" || step.status === "skipped") {
      outputs[step.stepId] = step.outputJson;
    }
  }
  return outputs;
}

function recordPersistedStep(params: {
  store: MetaRunStore;
  runId: string;
  step: MetaStep;
  inputJson: JsonRecord;
  result: MetaRunStepResult;
  updatedAtMs: number;
}): void {
  params.store.recordStepFinished({
    runId: params.runId,
    stepId: params.step.id,
    kind: params.step.kind,
    dependencyStateJson: buildDependencyStateJson(params.step, resolveStepStatus(params.result)),
    status: resolveStepStatus(params.result),
    inputJson: params.inputJson,
    outputJson: toJsonRecord("output" in params.result ? params.result.output : undefined),
    errorJson:
      "error" in params.result && params.result.error
        ? {
            message: params.result.error,
            ...("recovery" in params.result && params.result.recovery
              ? { recovery: params.result.recovery }
              : {}),
          }
        : undefined,
    updatedAtMs: params.updatedAtMs,
  });
}

function recordStartedStep(params: {
  store: MetaRunStore;
  runId: string;
  step: MetaStep;
  inputJson: JsonRecord;
  startedAtMs: number;
}): void {
  params.store.recordStepFinished({
    runId: params.runId,
    stepId: params.step.id,
    kind: params.step.kind,
    dependencyStateJson: buildDependencyStateJson(params.step, "ready"),
    status: "running",
    inputJson: params.inputJson,
    startedAtMs: params.startedAtMs,
    updatedAtMs: params.startedAtMs,
  });
}

function resolveStepsFrom(plan: MetaPlan, startAtStepId?: string): MetaStep[] {
  if (!startAtStepId) {
    return plan.steps;
  }
  const startIndex = plan.steps.findIndex((step) => step.id === startAtStepId);
  if (startIndex === -1) {
    throw new Error(
      `Persisted meta runner could not record pending steps for unknown step "${startAtStepId}" in plan "${plan.name}".`,
    );
  }
  return plan.steps.slice(startIndex);
}

function recordPendingSteps(params: {
  store: MetaRunStore;
  runId: string;
  plan: MetaPlan;
  input: MetaRunInput;
  updatedAtMs: number;
  startAtStepId?: string;
}): void {
  for (const step of resolveStepsFrom(params.plan, params.startAtStepId)) {
    params.store.recordStepFinished({
      runId: params.runId,
      stepId: step.id,
      kind: step.kind,
      dependencyStateJson: buildDependencyStateJson(step, "pending"),
      status: "pending",
      inputJson: params.input,
      updatedAtMs: params.updatedAtMs,
    });
  }
}

function maybeRecordPause(params: {
  store: MetaRunStore;
  runId: string;
  step: MetaStep;
  result: MetaRunStepResult;
  sessionKey?: string;
  createdAtMs: number;
  expiresAtMs: number;
  createId: () => string;
  channelBindingJson?: JsonRecord;
}): void {
  if (params.result.status !== "paused" || !params.sessionKey) {
    return;
  }
  const output = "output" in params.result ? params.result.output : undefined;
  if (!isMetaPauseOutput(output)) {
    return;
  }
  params.store.recordPause({
    pauseId: `pause-${params.createId()}`,
    runId: params.runId,
    stepId: params.step.id,
    schemaJson: output.schema ?? params.step.schema ?? {},
    sessionKey: params.sessionKey,
    expiresAtMs: params.expiresAtMs,
    createdAtMs: params.createdAtMs,
    ...(output.prefill ? { prefillJson: output.prefill } : {}),
    ...(params.channelBindingJson ? { channelBindingJson: params.channelBindingJson } : {}),
  });
}

function maybeRecordGateEvidence(params: {
  store: MetaRunStore;
  runId: string;
  results?: MetaGateResult[];
  proposalId?: string;
  createdAtMs: number;
  createId: () => string;
}): void {
  if (!params.results?.length) {
    return;
  }
  recordMetaGateEvidence({
    store: params.store,
    runId: params.runId,
    results: params.results,
    ...(params.proposalId ? { proposalId: params.proposalId } : {}),
    createdAtMs: params.createdAtMs,
    createId: params.createId,
  });
}

function resolveGateEvidence(params: {
  options: RunPersistedMetaPlanOptions;
  result: MetaRunResult;
}): MetaGateEvidence | undefined {
  const derived = params.options.deriveGateEvidence?.({
    plan: params.options.plan,
    result: params.result,
  });
  const results = [...(params.options.gateResults ?? []), ...(derived?.results ?? [])];
  if (results.length === 0) {
    return undefined;
  }
  return {
    results,
    proposalId: params.options.gateProposalId ?? derived?.proposalId,
  };
}

export async function runPersistedMetaPlan(
  options: RunPersistedMetaPlanOptions,
): Promise<PersistedMetaRunResult> {
  const nowMs = options.nowMs ?? Date.now;
  const createId = options.createId ?? randomUUID;
  const runId = options.runId ?? `meta-${createId()}`;
  const startedAtMs = nowMs();

  options.store.recordRunStarted({
    runId,
    skillName: options.plan.name,
    skillKey: resolveSkillKey(options.plan),
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
    ...(options.agentRunId ? { agentRunId: options.agentRunId } : {}),
    ...(options.channelTargetJson ? { channelTargetJson: options.channelTargetJson } : {}),
    ...(options.workspaceContextJson ? { workspaceContextJson: options.workspaceContextJson } : {}),
    inputJson: options.input,
    ...(options.triggerJson ? { triggerJson: options.triggerJson } : {}),
    originalInputSummary: options.originalInputSummary ?? summarizeOriginalInput(options.input),
    finalMode: options.finalMode ?? formatFinalTextMode(options.plan.finalTextMode),
    createdAtMs: startedAtMs,
  });
  recordPendingSteps({
    store: options.store,
    runId,
    plan: options.plan,
    input: options.input,
    updatedAtMs: startedAtMs,
  });

  const renderedStepInputs = new Map<string, JsonRecord>();
  const result = await runMetaPlan({
    ...options,
    onStepStarted: (event) => {
      renderedStepInputs.set(event.step.id, event.inputJson);
      recordStartedStep({
        store: options.store,
        runId,
        step: event.step,
        inputJson: event.inputJson,
        startedAtMs,
      });
    },
  });
  const completedAtMs = nowMs();
  const gateEvidence = resolveGateEvidence({ options, result });

  for (const [stepId, stepResult] of Object.entries(result.steps)) {
    const step = findStep(options.plan, stepId);
    recordPersistedStep({
      store: options.store,
      runId,
      step,
      inputJson: renderedStepInputs.get(stepId) ?? options.input,
      result: stepResult,
      updatedAtMs: completedAtMs,
    });
    maybeRecordPause({
      store: options.store,
      runId,
      step,
      result: stepResult,
      sessionKey: options.sessionKey,
      createdAtMs: completedAtMs,
      expiresAtMs: completedAtMs + (options.pauseTtlMs ?? DEFAULT_PAUSE_TTL_MS),
      createId,
      ...(options.channelBindingJson ? { channelBindingJson: options.channelBindingJson } : {}),
    });
  }

  options.store.recordRunCompleted({
    runId,
    status: resolveRunCompletedStatus(result.status),
    finalText: result.finalText,
    completedAtMs,
  });
  maybeRecordGateEvidence({
    store: options.store,
    runId,
    results: gateEvidence?.results,
    proposalId: gateEvidence?.proposalId,
    createdAtMs: completedAtMs,
    createId,
  });

  return {
    ...result,
    runId,
  };
}

export async function resumePersistedMetaPlan(
  options: ResumePersistedMetaPlanOptions,
): Promise<PersistedMetaRunResult> {
  const nowMs = options.nowMs ?? Date.now;
  const createId = options.createId ?? randomUUID;
  const startedAtMs = nowMs();
  const pause = options.store.readPendingPauseForSession(options.sessionKey, startedAtMs);
  if (!pause) {
    throw new Error(`No pending meta pause found for session "${options.sessionKey}".`);
  }

  const run = options.store.readRun(pause.runId);
  if (!run) {
    throw new Error(
      `Pending meta pause "${pause.pauseId}" references missing run "${pause.runId}".`,
    );
  }
  if (run.skillName !== options.plan.name) {
    throw new Error(
      `Pending meta pause "${pause.pauseId}" belongs to "${run.skillName}", not "${options.plan.name}".`,
    );
  }
  if (run.status !== "paused") {
    throw new Error(
      `Pending meta pause "${pause.pauseId}" belongs to non-paused run "${run.runId}".`,
    );
  }

  const input = mergeResumeInput({
    originalInput: run.inputJson,
    prefillJson: pause.prefillJson,
    resumeInput: options.input,
  });
  const priorOutputs = collectPriorOutputs({
    store: options.store,
    runId: pause.runId,
    plan: options.plan,
    startAtStepId: pause.stepId,
  });
  recordPendingSteps({
    store: options.store,
    runId: pause.runId,
    plan: options.plan,
    input,
    updatedAtMs: startedAtMs,
    startAtStepId: pause.stepId,
  });
  const renderedStepInputs = new Map<string, JsonRecord>();
  const result = await runMetaPlan({
    ...options,
    input,
    onStepStarted: (event) => {
      renderedStepInputs.set(event.step.id, event.inputJson);
      recordStartedStep({
        store: options.store,
        runId: pause.runId,
        step: event.step,
        inputJson: event.inputJson,
        startedAtMs,
      });
    },
    resume: {
      startAtStepId: pause.stepId,
      priorOutputs,
    },
  });
  const completedAtMs = nowMs();
  const gateEvidence = resolveGateEvidence({ options, result });

  options.store.markPauseResumed({
    pauseId: pause.pauseId,
    confirmedFieldsJson: stripInternalMetaInputContext(options.input),
    resumedAtMs: completedAtMs,
  });

  for (const [stepId, stepResult] of Object.entries(result.steps)) {
    const step = findStep(options.plan, stepId);
    recordPersistedStep({
      store: options.store,
      runId: pause.runId,
      step,
      inputJson: renderedStepInputs.get(stepId) ?? input,
      result: stepResult,
      updatedAtMs: completedAtMs,
    });
    maybeRecordPause({
      store: options.store,
      runId: pause.runId,
      step,
      result: stepResult,
      sessionKey: options.sessionKey,
      createdAtMs: completedAtMs,
      expiresAtMs: completedAtMs + (options.pauseTtlMs ?? DEFAULT_PAUSE_TTL_MS),
      createId,
      ...(options.channelBindingJson ? { channelBindingJson: options.channelBindingJson } : {}),
    });
  }

  options.store.recordRunCompleted({
    runId: pause.runId,
    status: resolveRunCompletedStatus(result.status),
    finalText: result.finalText,
    completedAtMs,
  });
  maybeRecordGateEvidence({
    store: options.store,
    runId: pause.runId,
    results: gateEvidence?.results,
    proposalId: gateEvidence?.proposalId,
    createdAtMs: completedAtMs,
    createId,
  });

  return {
    ...result,
    runId: pause.runId,
  };
}
