import { isDeepStrictEqual } from "node:util";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import { isPostgresSqlConnection, type EngineConnection } from "../../infra/sql-connection.js";
import { createSqliteSchemaEnsurer } from "../../infra/sqlite-schema-ensure.js";
import {
  getAdmittedSqliteSchemaFacts,
  type SqliteSchemaFacts,
} from "../../infra/sqlite-schema-facts.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { ensureStatePostgresFragment } from "../../state/openclaw-state-db-engine.js";
import { ensureColumn, tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { getOpenClawStateFeatureSchemaSql } from "../../state/openclaw-state-feature-schema.js";
import { drainWorkerSessionPlacement } from "./placement-drain.js";
import type {
  WorkerPlacementMoveIntent,
  WorkerPlacementMoveSource,
  WorkerPlacementMoveTarget,
} from "./placement-move-intent.types.js";
import {
  boundedIdentifier,
  normalizeOperationId,
  normalizeWorkerPlacementMoveTarget,
  normalizeWorkerPlacementMoveSource,
  workerPlacementMoveFromRow,
  MOVE_OPERATION_PREFIX,
  moveQuery,
  type MoveRow,
} from "./placement-move-row-codec.js";
import {
  isForceAbandonedWorkerPlacement,
  normalizeEpoch,
  required,
  type WorkerSessionPlacementRecord,
} from "./placement-record.js";
import { find, fromRow, getRequired, query, transitionValues } from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import { publishPlacementTurnClaimState } from "./placement-turn-authority.js";
import { boundedWorkerError } from "./worker-error.js";

type MoveSourceCompletion = {
  operationId: string;
  sessionId: string;
  expectedGeneration: number;
};

// Placement reads feed the resident session projection; do not repeat DDL/PRAGMA per row.
const ensuredMoveSchemaHandles = new WeakMap<EngineConnection, SqliteSchemaFacts>();
const installWorkerPlacementMoveSchema = createSqliteSchemaEnsurer(
  () =>
    getOpenClawStateFeatureSchemaSql("worker_session_placement_moves", {
      errorMessage: "Worker placement move schema marker is missing",
    }),
  { tables: ["worker_session_placement_moves"] },
);

function ensureWorkerPlacementMoveSchema(db: EngineConnection): void {
  if (isPostgresSqlConnection(db)) {
    ensureStatePostgresFragment(db, "worker_session_placement_moves");
    return;
  }
  const facts = getAdmittedSqliteSchemaFacts(db);
  if (facts && ensuredMoveSchemaHandles.get(db) === facts) {
    return;
  }
  installWorkerPlacementMoveSchema(db);
  // Databases that created this table before the column shipped upgrade in place;
  // the column is bare and nullable, so old readers stay compatible.
  ensureColumn(db, "worker_session_placement_moves", "target_machine_class TEXT");
  ensureColumn(db, "worker_session_placement_moves", "target_os TEXT");
  ensureColumn(db, "worker_session_placement_moves", "abandon_source INTEGER");
  const initialized = getAdmittedSqliteSchemaFacts(db);
  if (initialized) {
    ensuredMoveSchemaHandles.set(db, initialized);
  }
}

function ensureExistingWorkerPlacementMoveSchema(db: EngineConnection): boolean {
  const facts = getAdmittedSqliteSchemaFacts(db);
  if (facts && ensuredMoveSchemaHandles.get(db) === facts) {
    return true;
  }
  // Reads stay lazy: never create the optional table from a read path.
  if (!tableExists(db, "worker_session_placement_moves")) {
    return false;
  }
  ensureWorkerPlacementMoveSchema(db);
  return true;
}

function targetValues(target: WorkerPlacementMoveTarget): {
  target_kind: MoveRow["target_kind"];
  target_id: MoveRow["target_id"];
  target_machine_class: MoveRow["target_machine_class"];
  target_os: MoveRow["target_os"];
} {
  return {
    target_kind: target.kind,
    target_id:
      target.kind === "profile"
        ? target.profileId
        : target.kind === "device"
          ? target.deviceId
          : null,
    target_machine_class: target.kind === "profile" ? (target.machineClass ?? null) : null,
    target_os: target.kind === "profile" ? (target.os ?? null) : null,
  };
}

function findMoveRow(
  db: EngineConnection,
  column: "session_id" | "operation_id",
  value: string,
): MoveRow | undefined {
  if (!ensureExistingWorkerPlacementMoveSchema(db)) {
    return undefined;
  }
  return executeSqliteQueryTakeFirstSync(
    db,
    moveQuery(db)
      .selectFrom("worker_session_placement_moves")
      .selectAll()
      .where(column, "=", value),
  );
}

function requireExactMove(
  db: EngineConnection,
  input: { operationId: string; sessionId: string },
): WorkerPlacementMoveIntent {
  const operationId = normalizeOperationId(input.operationId);
  const sessionId = required(input.sessionId, "move session id");
  const row = findMoveRow(db, "operation_id", operationId);
  if (!row || row.session_id !== sessionId) {
    throw new Error(`Session ${sessionId} placement move changed before completion`);
  }
  return workerPlacementMoveFromRow(row);
}

function exactMoveValues(intent: WorkerPlacementMoveIntent) {
  return {
    operation_id: intent.operationId,
    session_id: intent.sessionId,
    source_generation: intent.source.generation,
    source_environment_id: intent.source.environmentId,
    source_owner_epoch: intent.source.ownerEpoch,
    ...targetValues(intent.target),
    abandon_source: intent.abandonSource ? 1 : null,
  };
}

function deleteExactMove(db: EngineConnection, intent: WorkerPlacementMoveIntent): void {
  const statement = moveQuery(db)
    .deleteFrom("worker_session_placement_moves")
    .where((eb) => eb.and(exactMoveValues(intent)));
  const result = executeSqliteQuerySync(db, statement);
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Session ${intent.sessionId} placement move changed before completion`);
  }
  sessionChanges.emit({ all: true, scope: "worker-placements" }, db);
}

function requireExactAttachedEnvironment(
  db: EngineConnection,
  input: {
    sessionId: string;
    environmentId: string;
    ownerEpoch: number;
    profileId?: string;
  },
): void {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    moveQuery(db)
      .selectFrom("worker_environments")
      .select(["state", "owner_epoch", "profile_id", "attached_session_ids_json"])
      .where("environment_id", "=", input.environmentId),
  );
  let attachedSessionIds: unknown;
  try {
    attachedSessionIds = row ? (JSON.parse(row.attached_session_ids_json) as unknown) : undefined;
  } catch {
    attachedSessionIds = undefined;
  }
  if (
    !row ||
    row.state !== "attached" ||
    row.owner_epoch !== input.ownerEpoch ||
    (input.profileId !== undefined && row.profile_id !== input.profileId) ||
    !Array.isArray(attachedSessionIds) ||
    attachedSessionIds.length !== 1 ||
    attachedSessionIds[0] !== input.sessionId
  ) {
    throw new Error(`Cannot move stale worker environment for session ${input.sessionId}`);
  }
}

export function createPlacementMoveOps(runtime: PlacementStoreRuntime) {
  const { write, now } = runtime;
  const completeSourceToLocal = (
    completion:
      | { state: "reconciling"; input: MoveSourceCompletion }
      | { state: "failed"; input: MoveSourceCompletion & { expectedRecoveryError: string } },
  ): { placement: WorkerSessionPlacementRecord; moveRemoved: boolean } =>
    write((db) => {
      const { state, input } = completion;
      const intent = requireExactMove(db, input);
      if (state === "failed" && (!intent.abandonSource || intent.target.kind !== "gateway")) {
        throw new Error(`Session ${intent.sessionId} placement move is not an abandonment`);
      }
      const current = getRequired(db, intent.sessionId);
      const label = state === "failed" ? "abandoned" : "Gateway";
      if (
        current.state !== state ||
        current.generation !== input.expectedGeneration ||
        current.environmentId !== intent.source.environmentId ||
        current.activeOwnerEpoch !== intent.source.ownerEpoch ||
        (state === "failed" &&
          (current.recoveryError !== input.expectedRecoveryError || current.turnClaim !== null))
      ) {
        throw new Error(
          `Cannot complete stale ${label} placement move for session ${intent.sessionId}`,
        );
      }
      const values = transitionValues(current, "local", {}, now());
      let statement = query(db)
        .updateTable("worker_session_placements")
        .set(values)
        .where("session_id", "=", intent.sessionId)
        .where("state", "=", state)
        .where("transition_generation", "=", current.generation)
        .where("environment_id", "=", intent.source.environmentId)
        .where("active_owner_epoch", "=", intent.source.ownerEpoch);
      if (state === "failed") {
        statement = statement.where("recovery_error", "=", input.expectedRecoveryError);
      }
      const result = executeSqliteQuerySync(
        db,
        statement.where("turn_claim_owner", "is", null).returningAll(),
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error(`Session ${intent.sessionId} changed during ${label} placement move`);
      }
      if (intent.target.kind === "gateway") {
        deleteExactMove(db, intent);
      }
      const record = fromRow(row);
      publishPlacementTurnClaimState(db, record);
      return { placement: record, moveRemoved: intent.target.kind === "gateway" };
    });

  return {
    beginPlacementMove(
      input: {
        sessionId: string;
        source: WorkerPlacementMoveSource;
        target: WorkerPlacementMoveTarget;
        abandonSource?: true;
      },
      beforeBegin?: (placement: WorkerSessionPlacementRecord, joined: boolean) => void,
    ): {
      intent: WorkerPlacementMoveIntent;
      placement: WorkerSessionPlacementRecord;
      joined: boolean;
    } {
      const sessionId = required(input.sessionId, "move session id");
      const source = normalizeWorkerPlacementMoveSource(input.source);
      const target = normalizeWorkerPlacementMoveTarget(input.target);
      const abandonSource = input.abandonSource === true;
      if (abandonSource && target.kind !== "gateway") {
        throw new Error("Worker placement move source abandonment requires a Gateway target");
      }
      const operationId = `${MOVE_OPERATION_PREFIX}${generateSecureToken(32)}`;
      return write((db) => {
        const existingRow = findMoveRow(db, "session_id", sessionId);
        if (existingRow) {
          const existing = workerPlacementMoveFromRow(existingRow);
          if (
            !isDeepStrictEqual(existing.source, source) ||
            !isDeepStrictEqual(existing.target, target) ||
            existing.abandonSource !== abandonSource
          ) {
            throw new Error(`Session ${sessionId} already has a conflicting placement move`);
          }
          const placement = getRequired(db, sessionId);
          beforeBegin?.(placement, true);
          return { intent: existing, placement, joined: true };
        }
        const current = getRequired(db, sessionId);
        if (
          (current.state !== "active" &&
            !(abandonSource && isForceAbandonedWorkerPlacement(current))) ||
          current.generation !== source.generation ||
          current.environmentId !== source.environmentId ||
          current.activeOwnerEpoch !== source.ownerEpoch
        ) {
          throw new Error(`Cannot move stale worker placement for session ${sessionId}`);
        }
        if (current.state === "active") {
          requireExactAttachedEnvironment(db, { sessionId, ...source });
        }
        beforeBegin?.(current, false);
        ensureWorkerPlacementMoveSchema(db);
        const timestamp = now();
        const row: MoveRow = {
          operation_id: operationId,
          session_id: sessionId,
          source_generation: source.generation,
          source_environment_id: source.environmentId,
          source_owner_epoch: source.ownerEpoch,
          ...targetValues(target),
          abandon_source: abandonSource ? 1 : null,
          last_error: null,
          created_at_ms: timestamp,
          updated_at_ms: timestamp,
        };
        executeSqliteQuerySync(
          db,
          moveQuery(db).insertInto("worker_session_placement_moves").values(row),
        );
        const placement =
          current.state === "failed"
            ? current
            : drainWorkerSessionPlacement(
                db,
                {
                  sessionId,
                  ...source,
                  expectedGeneration: source.generation,
                  ...(abandonSource ? { allowPendingWorkspaceResult: true } : {}),
                },
                timestamp,
              );
        return { intent: workerPlacementMoveFromRow(row), placement, joined: false };
      });
    },

    recordPlacementMoveError(input: {
      operationId: string;
      sessionId: string;
      error: string;
    }): boolean {
      return write((db) => {
        if (!tableExists(db, "worker_session_placement_moves")) {
          return false;
        }
        const statement = moveQuery(db)
          .updateTable("worker_session_placement_moves")
          .set({ last_error: boundedWorkerError(input.error), updated_at_ms: now() })
          .where("operation_id", "=", normalizeOperationId(input.operationId))
          .where("session_id", "=", required(input.sessionId, "move session id"));
        const changed = executeSqliteQuerySync(db, statement).numAffectedRows === 1n;
        if (changed) {
          sessionChanges.emit({ all: true, scope: "worker-placements" }, db);
        }
        return changed;
      });
    },

    cancelPlacementMove(input: {
      operationId: string;
      sessionId: string;
      expectedLocalGeneration?: number;
    }): boolean {
      return write((db) => {
        if (input.expectedLocalGeneration !== undefined) {
          const current = find(db, required(input.sessionId, "move session id"));
          if (current?.state !== "local" || current.generation !== input.expectedLocalGeneration) {
            return false;
          }
        }
        deleteExactMove(db, requireExactMove(db, input));
        return true;
      });
    },

    completePlacementMoveSourceToLocal(input: MoveSourceCompletion) {
      return completeSourceToLocal({ state: "reconciling", input });
    },

    completeAbandonedPlacementMoveSourceToLocal(
      input: MoveSourceCompletion & { expectedRecoveryError: string },
    ) {
      return completeSourceToLocal({ state: "failed", input });
    },

    completePlacementMoveToWorker(input: {
      operationId: string;
      sessionId: string;
      expectedGeneration: number;
      environmentId: string;
      ownerEpoch: number;
    }): WorkerSessionPlacementRecord {
      const environmentId = boundedIdentifier(
        input.environmentId,
        "move destination environment id",
      );
      const ownerEpoch = normalizeEpoch(input.ownerEpoch, "move destination owner epoch");
      return write((db) => {
        const intent = requireExactMove(db, input);
        if (intent.target.kind === "gateway") {
          throw new Error(`Session ${intent.sessionId} placement move target is not a worker`);
        }
        const current = getRequired(db, intent.sessionId);
        if (
          current.state !== "active" ||
          current.generation !== input.expectedGeneration ||
          current.environmentId !== environmentId ||
          current.activeOwnerEpoch !== ownerEpoch
        ) {
          throw new Error(
            `Cannot complete stale worker placement move for session ${intent.sessionId}`,
          );
        }
        const profileId =
          intent.target.kind === "profile"
            ? intent.target.profileId
            : `device:${intent.target.deviceId}`;
        requireExactAttachedEnvironment(db, {
          sessionId: intent.sessionId,
          environmentId,
          ownerEpoch,
          profileId,
        });
        deleteExactMove(db, intent);
        return current;
      });
    },
  };
}
