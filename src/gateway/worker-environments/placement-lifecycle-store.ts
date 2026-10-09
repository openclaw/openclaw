import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { WorkerOperations } from "../../state/worker-operation-registry.js";
import type { PreparedEnvironmentSelection } from "./environment-record.js";
import type { WorkerPlacementAuthorization } from "./placement-authorization.js";
import type { PlacementLifecycleReceipt } from "./placement-lifecycle.types.js";
import type { placementLifecycleOperations } from "./placement-lifecycle.worker.js";
import type { createPlacementMoveOps } from "./placement-move-intent.js";
import { required, type WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerSessionPlacementRetirement } from "./placement-retirement.js";
import {
  stagePlacementRetirementWorkerPublication,
  stagePlacementTurnClaimWorkerPublication,
  stagePlacementWorkspaceJournalWorkerPublication,
} from "./placement-turn-authority.js";
import { createPlacementWorkerMutation } from "./placement-worker-mutation.js";
import { reserveWorkerEnvironmentNativePublication } from "./store-native-publication.js";

type Moves = ReturnType<typeof createPlacementMoveOps>;
type Operations = WorkerOperations<typeof placementLifecycleOperations>;
type Guard = { assertCurrent?: WorkerPlacementAuthorization };

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
    const captured = structuredClone(command);
    captured.input.sessionId = required(captured.input.sessionId, "session id");
    let published = false;
    let newSource: WorkerSessionPlacementRecord | undefined;
    const mutation = createPlacementWorkerMutation<PlacementLifecycleReceipt>({
      context,
      label: "Worker placement lifecycle",
      nativeLocation: context.admission.databasePath,
      orderedAdmission: true,
      assertCurrent: assertCurrent?.assertWorkerLifetime ?? assertCurrent,
      assertGrantCurrent: assertCurrent?.assertWorkerGrant ?? assertCurrent,
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
      stageCommit(facts) {
        if (!isReceipt(facts) || facts.sessionId !== captured.input.sessionId) {
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
      readReceipt(facts) {
        return isReceipt(facts) && facts.sessionId === captured.input.sessionId ? facts : undefined;
      },
      publish(receipt) {
        if (published) {
          return;
        }
        published = true;
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
    async beginPlacementMove(
      input: Parameters<Moves["beginPlacementMove"]>[0],
      guard: Guard & { assertNewSource?: (placement: WorkerSessionPlacementRecord) => void } = {},
    ) {
      const receipt = await execute(
        { type: "workerPlacements.beginMove", input: { ...input, nowMs: runtime.now?.() } },
        guard.assertCurrent,
        guard.assertNewSource,
      );
      if (!receipt.intent || receipt.joined === undefined) {
        throw new Error("Worker placement move receipt is missing its intent");
      }
      return { intent: receipt.intent, placement: placement(receipt), joined: receipt.joined };
    },
    async recordPlacementMoveError(input: Parameters<Moves["recordPlacementMoveError"]>[0]) {
      return (
        (
          await execute({
            type: "workerPlacements.moveError",
            input: { ...input, nowMs: runtime.now?.() },
          })
        ).changed === true
      );
    },
    async cancelPlacementMove(
      input: Parameters<Moves["cancelPlacementMove"]>[0],
      guard: Guard = {},
    ) {
      return (
        (
          await execute(
            { type: "workerPlacements.cancelMove", input: { ...input, nowMs: runtime.now?.() } },
            guard.assertCurrent,
          )
        ).changed === true
      );
    },
    async completePlacementMoveSourceToLocal(
      input: Parameters<Moves["completePlacementMoveSourceToLocal"]>[0],
      guard: Guard = {},
    ) {
      return placement(
        await execute(
          {
            type: "workerPlacements.completeMoveSource",
            input: { ...input, nowMs: runtime.now?.() },
          },
          guard.assertCurrent,
        ),
      );
    },
    async completeAbandonedPlacementMoveSourceToLocal(
      input: Parameters<Moves["completeAbandonedPlacementMoveSourceToLocal"]>[0],
      guard: Guard = {},
    ) {
      return placement(
        await execute(
          {
            type: "workerPlacements.completeAbandonedMoveSource",
            input: { ...input, nowMs: runtime.now?.() },
          },
          guard.assertCurrent,
        ),
      );
    },
    async completePlacementMoveToWorker(
      input: Parameters<Moves["completePlacementMoveToWorker"]>[0],
      guard: Guard = {},
    ) {
      return placement(
        await execute(
          { type: "workerPlacements.completeMove", input: { ...input, nowMs: runtime.now?.() } },
          guard.assertCurrent,
        ),
      );
    },
    async bindPreparedEnvironment({ assertCurrent, ...input }: PreparedEnvironmentSelection) {
      return (
        await execute(
          { type: "workerPlacements.bindPrepared", input: { ...input, nowMs: runtime.now?.() } },
          assertCurrent,
        )
      ).placement;
    },
    async retireSessionPlacementAsync(input: WorkerSessionPlacementRetirement, guard: Guard = {}) {
      await execute(
        { type: "workerPlacements.retire", input: { ...input, nowMs: runtime.now?.() } },
        guard.assertCurrent,
      );
    },
  };
}
