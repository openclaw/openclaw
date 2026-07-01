import { randomUUID } from "node:crypto";
import type {
  DurableRuntimeRef,
  DurableRuntimeRun,
  DurableRuntimeStep,
  DurableRuntimeStepType,
  DurableRuntimeStore,
} from "./types.js";

export type DurableRuntimeIntakeRefInput = {
  refId?: string;
  mediaType?: string;
  hash?: string;
  storageKind?: DurableRuntimeRef["storageKind"];
  storageUri?: string;
  metadata?: Record<string, unknown>;
};

export type DurableRuntimeIntakeStepInput = {
  stepId?: string;
  stepType?: DurableRuntimeStepType;
  idempotencyKey?: string;
  maxAttempts?: number;
  metadata?: Record<string, unknown>;
};

export type DurableRuntimeIntakeInput = {
  store: DurableRuntimeStore;
  operationKind: string;
  operationVersion?: string;
  idempotencyKey?: string;
  requestHash?: string;
  sourceType?: string;
  sourceRef?: string;
  messageId?: string;
  turnId?: string;
  workUnitId?: string;
  reportRouteId?: string;
  input?: DurableRuntimeIntakeRefInput;
  initialStep?: DurableRuntimeIntakeStepInput;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type DurableRuntimeIntakeResult = {
  run: DurableRuntimeRun;
  inputRef?: DurableRuntimeRef;
  initialStep?: DurableRuntimeStep;
};

function defaultInputRefId(params: DurableRuntimeIntakeInput): string {
  const stableKey = params.idempotencyKey ?? params.messageId ?? params.turnId ?? randomUUID();
  return `intake:${params.operationKind}:${stableKey}:input`;
}

function defaultStepId(params: DurableRuntimeIntakeInput): string {
  const stableKey = params.idempotencyKey ?? params.messageId ?? params.turnId ?? randomUUID();
  return `intake:${params.operationKind}:${stableKey}:step`;
}

export function acceptDurableRuntimeIntake(
  params: DurableRuntimeIntakeInput,
): DurableRuntimeIntakeResult {
  const inputRefId = params.input ? (params.input.refId ?? defaultInputRefId(params)) : undefined;
  const run = params.store.createRun({
    operationKind: params.operationKind,
    operationVersion: params.operationVersion ?? "1",
    status: "received",
    recoveryState: "runnable",
    idempotencyKey: params.idempotencyKey,
    requestHash: params.requestHash,
    sourceType: params.sourceType,
    sourceRef: params.sourceRef,
    inputRef: inputRefId,
    messageId: params.messageId,
    turnId: params.turnId,
    workUnitId: params.workUnitId,
    reportRouteId: params.reportRouteId,
    metadata: params.metadata,
    now: params.now,
  });

  const inputRef =
    params.input && inputRefId
      ? (params.store.getRef(inputRefId) ??
        params.store.createRef({
          refId: inputRefId,
          runtimeRunId: run.runtimeRunId,
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
        runtimeRunId: run.runtimeRunId,
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
