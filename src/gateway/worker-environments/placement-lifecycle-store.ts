import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import type { WorkerOperations } from "../../state/worker-operation-registry.js";
import type { PreparedEnvironmentSelection } from "./environment-record.js";
import type { WorkerPlacementAuthorization } from "./placement-authorization.js";
import type { PlacementLifecycleReceipt } from "./placement-lifecycle.types.js";
import type { placementLifecycleOperations } from "./placement-lifecycle.worker.js";
import type { createPlacementMoveOps } from "./placement-move-intent.js";
import {
  normalizeIdentity,
  normalizeWorkerPlacementExecutionMode,
  required,
  type WorkerPlacementExecutionMode,
  type WorkerSessionPlacementDispatchIdentity,
  type WorkerSessionPlacementIdentity,
  type WorkerSessionPlacementRecord,
} from "./placement-record.js";
import type { WorkerSessionPlacementRetirement } from "./placement-retirement.js";
import {
  stagePlacementRetirementWorkerPublication,
  stagePlacementTurnClaimWorkerPublication,
  stagePlacementWorkspaceJournalWorkerPublication,
} from "./placement-turn-authority.js";
import { createPlacementWorkerMutation } from "./placement-worker-mutation.js";
import { reserveWorkerEnvironmentNativePublication } from "./store-native-publication.js";

type Moves = ReturnType<typeof createPlacementMoveOps>;
type Operations = Omit<
  WorkerOperations<typeof placementLifecycleOperations>,
  "workerPlacements.clearLocalTurnClaims"
>;
type Guard = { assertCurrent?: WorkerPlacementAuthorization };

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
    ...normalizeIdentity(identity),
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

function isReceipt(value: unknown): value is PlacementLifecycleReceipt {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    (value.placement === undefined ||
      (isRecord(value.placement) && value.placement.sessionId === value.sessionId)) &&
    (value.intent === undefined ||
      (isRecord(value.intent) && value.intent.sessionId === value.sessionId))
  );
}

export function createPlacementLifecycleWorkerOps(runtime: {
  path: string;
  now?: () => number;
  onRetired: (sessionId: string) => void;
}) {
  const context = captureOpenClawStateWorkerContext({ path: runtime.path });
  const execute = (
    command: SqliteWorkerCommand<Operations>,
    assertCurrent?: WorkerPlacementAuthorization,
    assertNewSource?: (placement: WorkerSessionPlacementRecord) => void,
  ) => {
    command.input = {
      ...command.input,
      nowMs:
        runtime.now?.() ??
        (command.type === "workerPlacements.startDispatch" ? Date.now() : undefined),
    };
    const captured = structuredClone(command);
    captured.input.sessionId = required(captured.input.sessionId, "session id");
    const readReceipt = (facts: unknown): PlacementLifecycleReceipt | undefined => {
      if (!isReceipt(facts) || facts.sessionId !== captured.input.sessionId) {
        return undefined;
      }
      return captured.type === "workerPlacements.startDispatch"
        ? {
            ...facts,
            placement: readDispatchReceipt(
              facts.placement,
              captured.input,
              captured.input.executionMode,
            ),
          }
        : facts;
    };
    const dispatch = captured.type === "workerPlacements.startDispatch";
    let newSource: WorkerSessionPlacementRecord | undefined;
    const mutation = createPlacementWorkerMutation<PlacementLifecycleReceipt>({
      context,
      label: dispatch ? "Worker placement dispatch" : "Worker placement lifecycle",
      nativeLocation: context.admission.databasePath,
      orderedAdmission: true,
      assertCurrent: dispatch
        ? assertCurrent
        : (assertCurrent?.assertWorkerLifetime ?? assertCurrent),
      assertGrantCurrent: dispatch
        ? assertCurrent
        : (assertCurrent?.assertWorkerGrant ?? assertCurrent),
      admissionFacts(request) {
        if (request.stage === "transaction" && assertNewSource) {
          const facts = request.facts;
          if (
            !isReceipt(facts) ||
            facts.sessionId !== captured.input.sessionId ||
            !facts.placement
          ) {
            throw new Error("Worker placement move admission has a different source");
          }
          newSource = facts.joined ? undefined : facts.placement;
        }
        if (newSource) {
          assertNewSource?.(newSource);
        }
        return request.facts;
      },
      stageCommit(committed) {
        const facts = readReceipt(committed);
        if (!facts) {
          throw new Error("Worker placement lifecycle receipt has a different session");
        }
        if (
          facts.joined ||
          facts.changed === false ||
          (captured.type === "workerPlacements.bindPrepared" && !facts.placement)
        ) {
          return undefined;
        }
        const publication = facts.retired
          ? stagePlacementRetirementWorkerPublication(
              context.admission.identity,
              facts.sessionId,
              facts.retired,
            )
          : facts.placement
            ? stagePlacementTurnClaimWorkerPublication(
                context.admission.identity,
                facts.placement,
                undefined,
                undefined,
                facts.placement,
              )
            : stagePlacementWorkspaceJournalWorkerPublication(
                context.admission.identity,
                facts.sessionId,
              );
        const environment = facts.environment;
        if (!environment) {
          return publication;
        }
        const publishEnvironment = reserveWorkerEnvironmentNativePublication(
          context.admission.identity,
        );
        return {
          ...publication,
          commit() {
            publishEnvironment?.(environment.environmentId, environment.patch);
            publication.commit();
          },
        };
      },
      readReceipt(facts, publication) {
        if (dispatch) {
          publication?.commit();
        }
        return readReceipt(facts);
      },
      publish(receipt) {
        if (captured.type === "workerPlacements.retire") {
          runtime.onRetired(receipt.sessionId);
        }
        if (
          receipt.changed === true ||
          receipt.moveRemoved ||
          captured.type === "workerPlacements.completeMove"
        ) {
          sessionChanges.emit({ all: true, scope: "worker-placements" });
        }
        if (receipt.environment) {
          sessionChanges.emit({ all: true, scope: "worker-environments" });
        }
      },
    });
    return mutation.run((scope) => scope.execute(captured));
  };
  const placement = (receipt: PlacementLifecycleReceipt) => {
    if (!receipt.placement) {
      throw new Error("Worker placement lifecycle receipt is missing its placement");
    }
    return receipt.placement;
  };
  return {
    async clearLocalTurnClaimsAfterRestartAsync(): Promise<number> {
      // Startup holds the state-directory lock and has not admitted turns.
      // An uncertain result aborts startup; the next boot can repeat this clear.
      const placements = await executeOpenClawStateWorker(context, {
        type: "workerPlacements.clearLocalTurnClaims",
        input: { nowMs: runtime.now?.() },
      });
      for (const clearedPlacement of placements) {
        stagePlacementTurnClaimWorkerPublication(
          context.admission.identity,
          clearedPlacement,
          undefined,
          clearedPlacement.state,
          clearedPlacement,
        ).commit();
      }
      return placements.length;
    },
    async startDispatch(input: WorkerSessionPlacementDispatchIdentity, guard: Guard = {}) {
      return placement(
        await execute(
          {
            type: "workerPlacements.startDispatch",
            input: {
              ...input,
              ...normalizeIdentity(input),
              executionMode: normalizeWorkerPlacementExecutionMode(input.executionMode),
            },
          },
          guard.assertCurrent,
        ),
      );
    },
    async beginPlacementMove(
      input: Parameters<Moves["beginPlacementMove"]>[0],
      guard: Guard & { assertNewSource?: (placement: WorkerSessionPlacementRecord) => void } = {},
    ) {
      const receipt = await execute(
        { type: "workerPlacements.beginMove", input },
        guard.assertCurrent,
        guard.assertNewSource,
      );
      if (!receipt.intent || receipt.joined === undefined) {
        throw new Error("Worker placement move receipt is missing its intent");
      }
      return { intent: receipt.intent, placement: placement(receipt), joined: receipt.joined };
    },
    async recordPlacementMoveError(input: Parameters<Moves["recordPlacementMoveError"]>[0]) {
      const receipt = await execute({ type: "workerPlacements.moveError", input });
      return receipt.changed === true;
    },
    async cancelPlacementMove(
      input: Parameters<Moves["cancelPlacementMove"]>[0],
      guard: Guard = {},
    ) {
      const receipt = await execute(
        { type: "workerPlacements.cancelMove", input },
        guard.assertCurrent,
      );
      return receipt.changed === true;
    },
    async completePlacementMoveSourceToLocal(
      input: Parameters<Moves["completePlacementMoveSourceToLocal"]>[0],
      guard: Guard = {},
    ) {
      return placement(
        await execute({ type: "workerPlacements.completeMoveSource", input }, guard.assertCurrent),
      );
    },
    async completeAbandonedPlacementMoveSourceToLocal(
      input: Parameters<Moves["completeAbandonedPlacementMoveSourceToLocal"]>[0],
      guard: Guard = {},
    ) {
      return placement(
        await execute(
          { type: "workerPlacements.completeAbandonedMoveSource", input },
          guard.assertCurrent,
        ),
      );
    },
    async completePlacementMoveToWorker(
      input: Parameters<Moves["completePlacementMoveToWorker"]>[0],
      guard: Guard = {},
    ) {
      return placement(
        await execute({ type: "workerPlacements.completeMove", input }, guard.assertCurrent),
      );
    },
    async bindPreparedEnvironment({ assertCurrent, ...input }: PreparedEnvironmentSelection) {
      return (await execute({ type: "workerPlacements.bindPrepared", input }, assertCurrent))
        .placement;
    },
    async retireSessionPlacementAsync(input: WorkerSessionPlacementRetirement, guard: Guard = {}) {
      await execute({ type: "workerPlacements.retire", input }, guard.assertCurrent);
    },
  };
}
