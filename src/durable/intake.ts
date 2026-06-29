import { randomUUID } from "node:crypto";
import type {
  DurableWorkflowRef,
  DurableWorkflowRun,
  DurableWorkflowStep,
  DurableWorkflowStepType,
  DurableWorkflowStore,
} from "./types.js";

export type DurableWorkflowIntakeRefInput = {
  refId?: string;
  mediaType?: string;
  hash?: string;
  storageKind?: DurableWorkflowRef["storageKind"];
  storageUri?: string;
  metadata?: Record<string, unknown>;
};

export type DurableWorkflowIntakeStepInput = {
  stepId?: string;
  stepType?: DurableWorkflowStepType;
  idempotencyKey?: string;
  maxAttempts?: number;
  metadata?: Record<string, unknown>;
};

export type DurableWorkflowIntakeInput = {
  store: DurableWorkflowStore;
  workflowId: string;
  workflowVersion?: string;
  idempotencyKey?: string;
  requestHash?: string;
  sourceType?: string;
  sourceRef?: string;
  messageId?: string;
  turnId?: string;
  input?: DurableWorkflowIntakeRefInput;
  initialStep?: DurableWorkflowIntakeStepInput;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type DurableWorkflowIntakeResult = {
  run: DurableWorkflowRun;
  inputRef?: DurableWorkflowRef;
  initialStep?: DurableWorkflowStep;
};

function defaultInputRefId(params: DurableWorkflowIntakeInput): string {
  const stableKey = params.idempotencyKey ?? params.messageId ?? params.turnId ?? randomUUID();
  return `intake:${params.workflowId}:${stableKey}:input`;
}

function defaultStepId(params: DurableWorkflowIntakeInput): string {
  const stableKey = params.idempotencyKey ?? params.messageId ?? params.turnId ?? randomUUID();
  return `intake:${params.workflowId}:${stableKey}:step`;
}

export function acceptDurableWorkflowIntake(
  params: DurableWorkflowIntakeInput,
): DurableWorkflowIntakeResult {
  const inputRefId = params.input ? (params.input.refId ?? defaultInputRefId(params)) : undefined;
  const run = params.store.createRun({
    workflowId: params.workflowId,
    workflowVersion: params.workflowVersion ?? "1",
    status: "received",
    recoveryState: "runnable",
    idempotencyKey: params.idempotencyKey,
    requestHash: params.requestHash,
    sourceType: params.sourceType,
    sourceRef: params.sourceRef,
    inputRef: inputRefId,
    messageId: params.messageId,
    turnId: params.turnId,
    metadata: params.metadata,
    now: params.now,
  });

  const inputRef =
    params.input && inputRefId
      ? (params.store.getRef(inputRefId) ??
        params.store.createRef({
          refId: inputRefId,
          workflowRunId: run.workflowRunId,
          refKind: "input",
          mediaType: params.input.mediaType,
          hash: params.input.hash,
          storageKind: params.input.storageKind ?? "external",
          storageUri: params.input.storageUri ?? inputRefId,
          metadata: params.input.metadata,
          now: params.now,
        }))
      : undefined;

  const initialStep = params.initialStep
    ? params.store.createStep({
        workflowRunId: run.workflowRunId,
        stepId: params.initialStep.stepId ?? defaultStepId(params),
        stepType: params.initialStep.stepType ?? "agent",
        status: "queued",
        recoveryState: "runnable",
        inputRef: inputRef?.refId,
        idempotencyKey:
          params.initialStep.idempotencyKey ??
          params.idempotencyKey ??
          params.messageId ??
          params.turnId,
        maxAttempts: params.initialStep.maxAttempts,
        metadata: params.initialStep.metadata,
        now: params.now,
      })
    : undefined;

  return { run, inputRef, initialStep };
}
