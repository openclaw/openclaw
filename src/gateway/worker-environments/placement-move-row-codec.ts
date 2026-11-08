import type { Selectable } from "kysely";
import { WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH } from "../../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type {
  DB as StateDatabase,
  WorkerSessionPlacementMoves,
} from "../../state/openclaw-state-db.generated.js";
import type {
  WorkerPlacementMoveIntent,
  WorkerPlacementMoveSource,
  WorkerPlacementMoveTarget,
} from "./placement-move-intent.types.js";
import { normalizeEpoch, required } from "./placement-record.js";

export const MOVE_OPERATION_PREFIX = "move:v1:";
const MOVE_MACHINE_CLASS_MAX_LENGTH = 128;
const MOVE_OS_MAX_LENGTH = 64;
export type MoveRow = Selectable<WorkerSessionPlacementMoves>;
type MoveDatabase = Pick<
  StateDatabase,
  "worker_environments" | "worker_session_placement_moves" | "worker_session_placements"
>;
export const moveQuery = (db: EngineConnection) => getNodeSqliteKysely<MoveDatabase>(db);

function normalizeGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Worker placement move source generation must be a non-negative integer");
  }
  return value;
}

export function boundedIdentifier(
  value: string,
  field: string,
  maximumLength = WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
): string {
  const normalized = required(value, field);
  if (normalized.length > maximumLength) {
    throw new Error(`Worker session placement ${field} exceeds ${maximumLength} characters`);
  }
  return normalized;
}

export function normalizeOperationId(value: string): string {
  const operationId = required(value, "move operation id");
  if (!operationId.startsWith(MOVE_OPERATION_PREFIX) || operationId.length > 128) {
    throw new Error("Worker session placement move operation id is invalid");
  }
  return operationId;
}

export function normalizeWorkerPlacementMoveTarget(
  target: WorkerPlacementMoveTarget,
): WorkerPlacementMoveTarget {
  if (target.kind !== "profile" && Object.hasOwn(target, "os")) {
    throw new Error("Worker placement move operating system requires a profile target");
  }
  switch (target.kind) {
    case "gateway":
      return { kind: "gateway" };
    case "profile": {
      const machineClass = target.machineClass;
      return {
        kind: "profile",
        profileId: boundedIdentifier(target.profileId, "move profile id"),
        ...(target.os === undefined
          ? {}
          : { os: boundedIdentifier(target.os, "move operating system", MOVE_OS_MAX_LENGTH) }),
        ...(machineClass === undefined
          ? {}
          : {
              machineClass: boundedIdentifier(
                machineClass,
                "move machine class",
                MOVE_MACHINE_CLASS_MAX_LENGTH,
              ),
            }),
      };
    }
    case "device":
      return { kind: "device", deviceId: boundedIdentifier(target.deviceId, "move device id") };
  }
  throw new Error("Worker placement move target is invalid");
}

export function normalizeWorkerPlacementMoveSource(
  source: WorkerPlacementMoveSource,
): WorkerPlacementMoveSource {
  return {
    generation: normalizeGeneration(source.generation),
    environmentId: boundedIdentifier(source.environmentId, "move source environment id"),
    ownerEpoch: normalizeEpoch(source.ownerEpoch, "move source owner epoch"),
  };
}

function normalizeAbandonSource(value: number | null): boolean {
  if (value === null) {
    return false;
  }
  if (value === 1) {
    return true;
  }
  throw new Error("Invalid worker placement move source abandonment value");
}

export function workerPlacementMoveFromRow(row: MoveRow): WorkerPlacementMoveIntent {
  const source = normalizeWorkerPlacementMoveSource({
    generation: row.source_generation,
    environmentId: row.source_environment_id,
    ownerEpoch: row.source_owner_epoch,
  });
  let target: WorkerPlacementMoveTarget;
  if (
    row.target_kind !== "profile" &&
    (row.target_machine_class !== null || row.target_os !== null)
  ) {
    throw new Error(`Invalid worker placement move target: ${row.target_kind}`);
  }
  if (row.target_kind === "gateway" && row.target_id === null) {
    target = { kind: "gateway" };
  } else if (row.target_kind === "profile" && row.target_id !== null) {
    target = normalizeWorkerPlacementMoveTarget({
      kind: "profile",
      profileId: row.target_id,
      ...(row.target_os === null ? {} : { os: row.target_os }),
      ...(row.target_machine_class === null ? {} : { machineClass: row.target_machine_class }),
    });
  } else if (row.target_kind === "device" && row.target_id !== null) {
    target = { kind: "device", deviceId: boundedIdentifier(row.target_id, "move device id") };
  } else {
    throw new Error(`Invalid worker placement move target: ${row.target_kind}`);
  }
  const abandonSource = normalizeAbandonSource(row.abandon_source);
  if (abandonSource && target.kind !== "gateway") {
    throw new Error("Worker placement move source abandonment requires a Gateway target");
  }
  return {
    operationId: normalizeOperationId(row.operation_id),
    sessionId: required(row.session_id, "move session id"),
    source,
    target,
    abandonSource,
    lastError: row.last_error,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

/** Display reads tolerate the shipped additive columns without mutating their source. */
export function readWorkerPlacementMovesReadOnly(
  db: EngineConnection,
  sessionIds: readonly string[],
): ReadonlyMap<string, WorkerPlacementMoveIntent> {
  const results = new Map<string, WorkerPlacementMoveIntent>();
  if (!tableExists(db, "worker_session_placement_moves")) {
    return results;
  }
  for (let offset = 0; offset < sessionIds.length; offset += 250) {
    for (const row of executeSqliteQuerySync(
      db,
      moveQuery(db)
        .selectFrom("worker_session_placement_moves")
        .selectAll()
        .where("session_id", "in", sessionIds.slice(offset, offset + 250)),
    ).rows) {
      const intent = workerPlacementMoveFromRow({
        ...row,
        target_machine_class: row.target_machine_class ?? null,
        target_os: row.target_os ?? null,
        abandon_source: row.abandon_source ?? null,
      });
      results.set(intent.sessionId, intent);
    }
  }
  return results;
}
