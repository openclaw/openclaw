import { randomUUID } from "node:crypto";
import type {
  DurableWorkflowSignal,
  DurableWorkflowSignalStatus,
  DurableWorkflowStep,
  DurableWorkflowStore,
} from "./types.js";

export type DurableHumanSignalType = "human_input" | "approval" | "rejection" | "resume";

export type RequestDurableHumanSignalInput = {
  store: DurableWorkflowStore;
  workflowRunId: string;
  stepId?: string;
  requestId?: string;
  promptRef?: string;
  signalType?: DurableHumanSignalType;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type SubmitDurableHumanSignalInput = {
  store: DurableWorkflowStore;
  workflowRunId: string;
  stepId?: string;
  signalType?: DurableHumanSignalType;
  idempotencyKey?: string;
  payloadRef?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type SubmitDurableHumanSignalResult = {
  signal: DurableWorkflowSignal;
  created: boolean;
};

function defaultHumanStepId(requestId: string | undefined): string {
  return `human:${requestId ?? randomUUID()}`;
}

function findStep(
  store: DurableWorkflowStore,
  workflowRunId: string,
  stepId: string,
): DurableWorkflowStep | undefined {
  return store.listSteps(workflowRunId).find((step) => step.stepId === stepId);
}

export function requestDurableHumanSignal(
  input: RequestDurableHumanSignalInput,
): DurableWorkflowStep {
  const now = input.now ?? Date.now();
  const stepId = input.stepId ?? defaultHumanStepId(input.requestId);
  const metadata = {
    requestId: input.requestId,
    promptRef: input.promptRef,
    signalType: input.signalType ?? "human_input",
    ...input.metadata,
  };
  const existing = findStep(input.store, input.workflowRunId, stepId);
  const step = existing
    ? input.store.updateStep({
        workflowRunId: input.workflowRunId,
        stepId,
        status: "waiting",
        recoveryState: "waiting_signal",
        inputRef: input.promptRef,
        metadata,
        now,
      })
    : input.store.createStep({
        workflowRunId: input.workflowRunId,
        stepId,
        stepType: "signal",
        status: "waiting",
        recoveryState: "waiting_signal",
        inputRef: input.promptRef,
        idempotencyKey: input.requestId,
        metadata,
        now,
      });
  input.store.updateRun({
    workflowRunId: input.workflowRunId,
    status: "waiting_signal",
    recoveryState: "waiting_signal",
    now,
  });
  input.store.appendEvent({
    workflowRunId: input.workflowRunId,
    eventType: "workflow.human_signal.requested",
    eventTime: now,
    stepId,
    correlationId: input.requestId,
    payload: metadata,
  });
  return step ?? findStep(input.store, input.workflowRunId, stepId)!;
}

export function submitDurableHumanSignal(
  input: SubmitDurableHumanSignalInput,
): SubmitDurableHumanSignalResult {
  const existing =
    input.idempotencyKey &&
    input.store
      .listSignals(input.workflowRunId)
      .find((signal) => signal.idempotencyKey === input.idempotencyKey);
  if (existing) {
    return { signal: existing, created: false };
  }

  const signal = input.store.createSignal({
    workflowRunId: input.workflowRunId,
    stepId: input.stepId,
    signalType: input.signalType ?? "human_input",
    idempotencyKey: input.idempotencyKey,
    payloadRef: input.payloadRef,
    correlationId: input.correlationId ?? input.idempotencyKey,
    metadata: input.metadata,
    now: input.now,
  });
  input.store.appendEvent({
    workflowRunId: input.workflowRunId,
    eventType: "workflow.human_signal.received",
    eventTime: input.now,
    stepId: input.stepId,
    correlationId: signal.correlationId,
    payload: {
      signalId: signal.signalId,
      signalType: signal.signalType,
      signalStatus: "pending" satisfies DurableWorkflowSignalStatus,
      payloadRef: signal.payloadRef,
    },
  });
  return { signal, created: true };
}
