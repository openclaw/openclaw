import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { PreparedEnvironmentSelection } from "./environment-record.js";
import type { WorkerPlacementDispatchStoreOperations } from "./placement-dispatch-store.worker-contract.js";
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
import { readWorkerEnvironmentPreparation } from "./prepared-environment-store.js";
import { isWorkerEnvironmentCommitAdmission } from "./store-commit-authority.js";
import {
  reconcilePendingWorkerEnvironmentMutations,
  reserveWorkerEnvironmentNativePublication,
} from "./store-native-publication.js";
import { workerEnvironmentProjections } from "./store-projection.js";

export class PreparedEnvironmentBindingIndeterminateError extends Error {
  override name = "PreparedEnvironmentBindingIndeterminateError";
  constructor(cause: unknown) {
    super("Prepared worker binding is indeterminate and requires recovery", { cause });
  }
}

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
  prepared?: { environmentId: string; expectedGeneration: number },
): WorkerSessionPlacementRecord {
  if (
    !isRecord(value) ||
    value.state !== (prepared ? "provisioning" : "requested") ||
    value.sessionId !== identity.sessionId ||
    value.agentId !== identity.agentId ||
    value.sessionKey !== identity.sessionKey ||
    value.executionMode !== executionMode
  ) {
    throw new Error("Worker placement dispatch receipt has a different identity");
  }
  const metadata = {
    environmentId: prepared?.environmentId ?? null,
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
  if (Object.entries(metadata).some(([key, field]) => value[key] !== field)) {
    throw new Error("Worker placement dispatch receipt retains worker metadata");
  }
  const number = (key: string): number => {
    const field = value[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
      throw new Error(`Worker placement dispatch receipt has an invalid ${key}`);
    }
    return field;
  };
  const facts = {
    ...identity,
    ...metadata,
    executionMode,
    generation: number("generation"),
    createdAtMs: number("createdAtMs"),
    updatedAtMs: number("updatedAtMs"),
    stateChangedAtMs: number("stateChangedAtMs"),
  };
  if (prepared) {
    if (value.turnClaim !== null || facts.generation !== prepared.expectedGeneration + 1) {
      throw new Error("Prepared worker binding receipt has a different placement owner");
    }
    return { ...facts, state: "provisioning", turnClaim: null };
  }
  return {
    ...facts,
    state: "requested",
    environmentId: null,
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

export async function bindPreparedWorkerEnvironment(
  path: string,
  input: PreparedEnvironmentSelection,
  nowMs?: number,
): Promise<WorkerSessionPlacementRecord | undefined> {
  const context = captureOpenClawStateWorkerContext({ path });
  const owner = workerEnvironmentProjections.get(context.admission.identity);
  if (!owner) {
    throw new Error("Prepared worker binding requires its initialized environment inventory");
  }
  const token = {};
  const assertInventoryCurrent = () => {
    context.admission.assertCurrent();
    if (!owner.active || workerEnvironmentProjections.get(context.admission.identity) !== owner) {
      throw new Error("Prepared worker binding lost its original environment inventory");
    }
  };
  const reconcilePending = () =>
    reconcilePendingWorkerEnvironmentMutations({
      owner,
      assertCurrent: assertInventoryCurrent,
      snapshot: async (ids) => {
        assertInventoryCurrent();
        const reply = await executeExistingOpenClawStateRead(
          { path },
          { type: "workerEnvironments.snapshot", ids },
        );
        assertInventoryCurrent();
        if (!reply || !reply.ok || reply.type !== "workerEnvironments.snapshot") {
          throw new Error("Worker environment inventory could not be read");
        }
        return reply.facts;
      },
    });
  const { assertCurrent, ...selected } = input;
  const selection = structuredClone(selected);
  const identity = normalizeIdentity(selection);
  const executionMode = normalizeWorkerPlacementExecutionMode(selection.executionMode);
  type Receipt =
    WorkerPlacementDispatchStoreOperations["workerPlacements.bindPreparedEnvironment"]["output"];
  const readReceipt = (value: unknown): Receipt => {
    if (!isRecord(value)) {
      throw new Error("Prepared worker binding has no commit receipt");
    }
    if (value.placement === null && value.environment === null) {
      return { placement: null, environment: null, environmentAdmission: [] };
    }
    if (
      !isWorkerEnvironmentCommitAdmission(value.environmentAdmission) ||
      value.environmentAdmission.length !== 1 ||
      value.environmentAdmission[0]?.environmentId !== selection.environmentId
    ) {
      throw new Error("Prepared worker binding receipt has invalid environment admission");
    }
    const environment = value.environment;
    if (
      !isRecord(environment) ||
      environment.environmentId !== selection.environmentId ||
      typeof environment.updatedAtMs !== "number" ||
      !Number.isSafeInteger(environment.updatedAtMs) ||
      environment.updatedAtMs < 0 ||
      !isRecord(environment.preparation)
    ) {
      throw new Error("Prepared worker binding receipt has a different environment owner");
    }
    const preparation = environment.preparation;
    if (
      (preparation.purpose !== "reserve" && preparation.purpose !== "build") ||
      preparation.key !== selection.preparationKey ||
      preparation.consumedAtMs !== environment.updatedAtMs ||
      typeof preparation.demandAtMs !== "number" ||
      typeof preparation.expiresAtMs !== "number"
    ) {
      throw new Error("Prepared worker binding receipt has invalid consumption facts");
    }
    const admittedPreparation = readWorkerEnvironmentPreparation({
      preparation_purpose: preparation.purpose,
      preparation_key: preparation.key,
      preparation_demand_at_ms: preparation.demandAtMs,
      preparation_expires_at_ms: preparation.expiresAtMs,
      preparation_consumed_at_ms: environment.updatedAtMs,
    });
    if (!admittedPreparation) {
      throw new Error("Prepared worker binding receipt lost its consumption facts");
    }
    return {
      placement: readDispatchReceipt(value.placement, identity, executionMode, selection),
      environmentAdmission: value.environmentAdmission,
      environment: {
        environmentId: selection.environmentId,
        updatedAtMs: environment.updatedAtMs,
        preparation: admittedPreparation,
      },
    };
  };
  let notified = false;
  let environmentUncertain = false;
  const mutation = createPlacementWorkerMutation<Receipt>({
    context,
    label: "Prepared worker binding",
    nativeLocation: context.admission.databasePath,
    orderedAdmission: true,
    assertCurrent: () =>
      owner.withAdmission(token, () => {
        assertInventoryCurrent();
        assertCurrent();
      }),
    stageCommit(facts) {
      const receipt = readReceipt(facts);
      if (!receipt.placement || !receipt.environment) {
        return undefined;
      }
      const environment = receipt.environment;
      owner.fence(receipt.environmentAdmission, token);
      const publication = stagePlacementTurnClaimWorkerPublication(
        context.admission.identity,
        receipt.placement,
      );
      const publishEnvironment = reserveWorkerEnvironmentNativePublication(
        context.admission.identity,
      );
      let committed = false;
      return {
        ...publication,
        commit() {
          if (committed) {
            return;
          }
          publishEnvironment?.(environment.environmentId, {
            preparation: environment.preparation,
            updatedAtMs: environment.updatedAtMs,
          });
          publication.commit();
          owner.release(token);
          committed = true;
        },
        rollback() {
          publication.rollback();
          owner.release(token);
        },
        invalidate() {
          environmentUncertain = true;
          publication.invalidate();
          owner.retainReconciliation(
            token,
            [selection.environmentId],
            new Error("Prepared worker binding commit outcome is unknown"),
          );
        },
      };
    },
    readReceipt,
    async recoverUnknown(error, publication) {
      publication?.invalidate();
      try {
        await reconcilePending();
      } catch (readbackError) {
        throw new PreparedEnvironmentBindingIndeterminateError(readbackError);
      }
      // Inventory recovery alone cannot attest the coupled placement postimage.
      throw new PreparedEnvironmentBindingIndeterminateError(error);
    },
    publish(receipt) {
      if (!notified && receipt.placement) {
        notified = true;
        sessionChanges.emit({ all: true, scope: "worker-environments" });
      }
    },
  });
  const releaseOwner = owner.retain();
  try {
    return await owner.enqueue(async () => {
      await reconcilePending();
      try {
        const receipt = await mutation.run((scope) =>
          scope.execute({
            type: "workerPlacements.bindPreparedEnvironment",
            input: { selection, nowMs },
          }),
        );
        return receipt.placement ?? undefined;
      } finally {
        if (!environmentUncertain) {
          owner.release(token);
        }
      }
    });
  } finally {
    if (releaseOwner()) {
      workerEnvironmentProjections.remove(owner);
    }
  }
}
