import { randomUUID } from "node:crypto";
import type {
  DurableRuntimeSignal,
  DurableRuntimeSignalStatus,
  DurableRuntimeStep,
  DurableRuntimeStore,
} from "./types.js";

export type DurableHumanSignalType = "human_input" | "approval" | "rejection" | "resume";

export type RequestDurableHumanSignalInput = {
  store: DurableRuntimeStore;
  runtimeRunId: string;
  stepId?: string;
  requestId?: string;
  promptRef?: string;
  signalType?: DurableHumanSignalType;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type SubmitDurableHumanSignalInput = {
  store: DurableRuntimeStore;
  runtimeRunId: string;
  stepId?: string;
  signalType?: DurableHumanSignalType;
  idempotencyKey?: string;
  payloadRef?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type SubmitDurableHumanSignalResult = {
  signal: DurableRuntimeSignal;
  created: boolean;
};

function defaultHumanStepId(requestId: string | undefined): string {
  return `human:${requestId ?? randomUUID()}`;
}

function findStep(
  store: DurableRuntimeStore,
  runtimeRunId: string,
  stepId: string,
): DurableRuntimeStep | undefined {
  return store.listSteps(runtimeRunId).find((step) => step.stepId === stepId);
}

export function requestDurableHumanSignal(
  input: RequestDurableHumanSignalInput,
): DurableRuntimeStep {
  const now = input.now ?? Date.now();
  const stepId = input.stepId ?? defaultHumanStepId(input.requestId);
  const metadata = {
    requestId: input.requestId,
    promptRef: input.promptRef,
    signalType: input.signalType ?? "human_input",
    ...input.metadata,
  };
  const existing = findStep(input.store, input.runtimeRunId, stepId);
  const step = existing
    ? input.store.updateStep({
        runtimeRunId: input.runtimeRunId,
        stepId,
        status: "waiting",
        recoveryState: "waiting_signal",
        inputRef: input.promptRef,
        metadata,
        now,
      })
    : input.store.createStep({
        runtimeRunId: input.runtimeRunId,
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
    runtimeRunId: input.runtimeRunId,
    status: "waiting_signal",
    recoveryState: "waiting_signal",
    now,
  });
  input.store.appendEvent({
    runtimeRunId: input.runtimeRunId,
    eventType: "runtime.human_signal.requested",
    eventTime: now,
    stepId,
    correlationId: input.requestId,
    payload: metadata,
  });
  return step ?? findStep(input.store, input.runtimeRunId, stepId)!;
}

export function submitDurableHumanSignal(
  input: SubmitDurableHumanSignalInput,
): SubmitDurableHumanSignalResult {
  const existing =
    input.idempotencyKey &&
    input.store
      .listSignals(input.runtimeRunId)
      .find((signal) => signal.idempotencyKey === input.idempotencyKey);
  if (existing) {
    return { signal: existing, created: false };
  }

  const signal = input.store.createSignal({
    runtimeRunId: input.runtimeRunId,
    stepId: input.stepId,
    signalType: input.signalType ?? "human_input",
    idempotencyKey: input.idempotencyKey,
    payloadRef: input.payloadRef,
    correlationId: input.correlationId ?? input.idempotencyKey,
    metadata: input.metadata,
    now: input.now,
  });
  input.store.appendEvent({
    runtimeRunId: input.runtimeRunId,
    eventType: "runtime.human_signal.received",
    eventTime: input.now,
    stepId: input.stepId,
    correlationId: signal.correlationId,
    payload: {
      signalId: signal.signalId,
      signalType: signal.signalType,
      signalStatus: "pending" satisfies DurableRuntimeSignalStatus,
      payloadRef: signal.payloadRef,
    },
  });
  return { signal, created: true };
}
