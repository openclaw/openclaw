import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  normalizeIdentity,
  normalizeWorkerPlacementExecutionMode,
  type WorkerPlacementExecutionMode,
  type WorkerSessionPlacementDispatchIdentity,
  type WorkerSessionPlacementIdentity,
  type WorkerSessionPlacementRecord,
} from "./placement-record.js";
import { stagePlacementTurnClaimWorkerPublication } from "./placement-turn-authority.js";
import { createPlacementWorkerMutation } from "./placement-worker-mutation.js";

type RequestedPlacement = Extract<WorkerSessionPlacementRecord, { state: "requested" }>;

function readDispatchTurnClaim(value: unknown): RequestedPlacement["turnClaim"] {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    value.owner !== "local" ||
    typeof value.claimId !== "string" ||
    !value.claimId ||
    typeof value.runId !== "string" ||
    !value.runId ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    value.ownerEpoch !== null
  ) {
    throw new Error("Worker placement dispatch commit has an invalid predecessor claim");
  }
  return {
    owner: "local",
    claimId: value.claimId,
    runId: value.runId,
    generation: value.generation,
    ownerEpoch: null,
  };
}

function readDispatchReceipt(
  value: unknown,
  identity: WorkerSessionPlacementIdentity,
  executionMode: WorkerPlacementExecutionMode,
): RequestedPlacement {
  if (
    !isRecord(value) ||
    value.state !== "requested" ||
    value.sessionId !== identity.sessionId ||
    value.agentId !== identity.agentId ||
    value.sessionKey !== identity.sessionKey ||
    value.executionMode !== executionMode
  ) {
    throw new Error("Worker placement dispatch receipt has a different identity");
  }
  const metadata = {
    environmentId: null,
    activeOwnerEpoch: null,
    workspaceBaseManifestRef: null,
    remoteWorkspaceDir: null,
    workerBundleHash: null,
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
  };
  if (Object.keys(metadata).some((key) => value[key] !== null)) {
    throw new Error("Worker placement dispatch receipt retains worker metadata");
  }
  const number = (key: string): number => {
    const field = value[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
      throw new Error(`Worker placement dispatch receipt has an invalid ${key}`);
    }
    return field;
  };
  return {
    ...identity,
    ...metadata,
    state: "requested",
    executionMode,
    generation: number("generation"),
    createdAtMs: number("createdAtMs"),
    updatedAtMs: number("updatedAtMs"),
    stateChangedAtMs: number("stateChangedAtMs"),
    turnClaim: readDispatchTurnClaim(value.turnClaim),
  };
}

export async function startWorkerPlacementDispatch(
  path: string,
  placement: WorkerSessionPlacementDispatchIdentity,
  nowMs: number,
  assertCurrent?: () => void,
): Promise<WorkerSessionPlacementRecord> {
  const context = captureOpenClawStateWorkerContext({ path });
  const captured = structuredClone(placement);
  const identity = normalizeIdentity(captured);
  const executionMode = normalizeWorkerPlacementExecutionMode(captured.executionMode);
  const mutation = createPlacementWorkerMutation<WorkerSessionPlacementRecord>({
    context,
    label: "Worker placement dispatch",
    nativeLocation: context.admission.databasePath,
    orderedAdmission: true,
    assertCurrent,
    stageCommit(facts) {
      return stagePlacementTurnClaimWorkerPublication(context.admission.identity, {
        ...identity,
        state: "requested",
        executionMode,
        environmentId: null,
        activeOwnerEpoch: null,
        turnClaim: readDispatchTurnClaim(facts),
      });
    },
    readReceipt(facts, publication) {
      publication?.commit();
      return readDispatchReceipt(facts, identity, executionMode);
    },
  });
  return mutation.run((scope) =>
    scope.execute({
      type: "workerPlacements.startDispatch",
      input: { placement: captured, nowMs },
    }),
  );
}
