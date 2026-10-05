import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { workerEnvironmentServiceError } from "./environment-errors.js";
import type { WorkerEnvironmentPreparedRecoveryHold } from "./environment-record.js";
import { hasWorkerEnvironmentSessionAttachment } from "./session-attachment-store.js";
import { revokeCredential, updateWorkerEnvironmentRecord } from "./store-mutations.js";
import { findWorkerEnvironment, json } from "./store-row-codec.js";
import { collectFailureDiagnostic } from "./worker-recovery-diagnostic.js";

const query = (db: DatabaseSync) =>
  getNodeSqliteKysely<
    Pick<
      DB,
      "worker_environments" | "worker_environment_recovery_holds" | "worker_session_placements"
    >
  >(db);

export function retainPreparedWorkerEnvironment(
  db: DatabaseSync,
  hold: WorkerEnvironmentPreparedRecoveryHold & { capacity: number },
) {
  const environment = findWorkerEnvironment(db, hold.environmentId);
  if (
    !environment ||
    environment.ownerEpoch !== hold.ownerEpoch ||
    environment.leaseId !== hold.leaseId ||
    environment.sharedHost !== false ||
    environment.preparation?.purpose !== "reserve" ||
    environment.preparation.key !== hold.preparationKey ||
    environment.preparation.consumedAtMs !== null ||
    environment.destroyRequestedAtMs === null ||
    environment.attachedSessionIds.length !== 0 ||
    !["ready", "idle", "draining", "destroying", "orphaned"].includes(environment.state) ||
    hasWorkerEnvironmentSessionAttachment(db, hold.environmentId) ||
    executeSqliteQueryTakeFirstSync(
      db,
      query(db)
        .selectFrom("worker_session_placements")
        .select("session_id")
        .where("environment_id", "=", hold.environmentId)
        .limit(1),
    )
  ) {
    throw new Error("Unused prepared worker ownership changed before retaining its resources");
  }
  const existing = environment.recoveryHold;
  if (existing) {
    if (
      existing.kind !== "prepared" ||
      existing.preparationKey !== hold.preparationKey ||
      existing.leaseId !== hold.leaseId ||
      existing.ownerEpoch !== hold.ownerEpoch
    ) {
      throw new Error("Prepared worker custody identity changed");
    }
    if (existing.phase === "held" || hold.phase === "requested") {
      return environment;
    }
    if (
      !hold.receipt ||
      hold.receipt.leaseId !== hold.leaseId ||
      hold.receipt.status !== "held" ||
      hold.receipt.unacceptedChanges !== "unknown" ||
      !hold.receipt.resources.some(
        (resource) => resource.kind === "vm" && resource.state === "absent",
      )
    ) {
      throw new Error("Prepared custody requires the exact provider-held absent compute receipt");
    }
    const { capacity: _capacity, ...recorded } = hold;
    executeSqliteQuerySync(
      db,
      query(db)
        .updateTable("worker_environment_recovery_holds")
        .set({
          hold_json: json({
            ...recorded,
            createdAtMs: existing.createdAtMs,
            diagnostic: existing.diagnostic,
            cleanup: existing.cleanup,
          }),
        })
        .where("environment_id", "=", hold.environmentId)
        .where("session_id", "is", null),
    );
  } else {
    const count = executeSqliteQueryTakeFirstSync(
      db,
      query(db)
        .selectFrom("worker_environment_recovery_holds")
        .innerJoin(
          "worker_environments",
          "worker_environments.environment_id",
          "worker_environment_recovery_holds.environment_id",
        )
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("session_id", "is", null)
        .where("worker_environments.state", "!=", "destroyed"),
    );
    if (!Number.isSafeInteger(hold.capacity) || hold.capacity < 1) {
      throw workerEnvironmentServiceError("invalid_state", "Invalid prepared custody capacity");
    }
    if ((count?.count ?? 0) >= hold.capacity) {
      throw workerEnvironmentServiceError(
        "capacity",
        "Retained prepared worker capacity is full; salvage a held reserve before another replacement",
      );
    }
    if (hold.phase !== "requested" || hold.receipt) {
      throw new Error("Prepared custody must be reserved before provider confirmation");
    }
    const { capacity: _capacity, ...recorded } = hold;
    executeSqliteQuerySync(
      db,
      query(db)
        .insertInto("worker_environment_recovery_holds")
        .values({
          environment_id: hold.environmentId,
          session_id: null,
          hold_json: json({
            ...recorded,
            cleanup: undefined,
            diagnostic: collectFailureDiagnostic(
              "unused-prepared-worker",
              environment.lastError,
              hold.createdAtMs,
            ),
          }),
        }),
    );
    revokeCredential(db, hold.environmentId);
  }
  return updateWorkerEnvironmentRecord(db, hold.environmentId, environment.state, {
    state: "orphaned",
    state_changed_at_ms: environment.recoveryHold ? environment.stateChangedAtMs : hold.createdAtMs,
    updated_at_ms: hold.createdAtMs,
    last_error:
      environment.lastError ??
      (hold.phase === "held"
        ? `Unused prepared lease ${hold.leaseId} is held; disk and companions remain retained for salvage.`
        : `Retaining unused prepared lease ${hold.leaseId}; provider confirmation is pending and capacity remains reserved.`),
  });
}
