import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { worktreeRegistryPublication } from "./registry-publication.js";
import { assertWorktreeRegistryPredicates } from "./registry-run-end.worker.js";
import { collectLiveRunLeases, worktreeRunLeaseScope } from "./run-lease-owner.js";
import type { ManagedWorktreeRecord } from "./types.js";

export type WorktreeRunLeaseRowInput = {
  worktreeId: string;
  token: string;
  pid: number;
  startTime: number | null;
  now: number;
  exclusive?: true;
  observed?: ManagedWorktreeRecord;
};

export function admitWorktreeRunLeaseInDatabase(
  db: EngineConnection,
  params: WorktreeRunLeaseRowInput,
): void {
  if (params.observed) {
    assertWorktreeRegistryPredicates(db, [{ kind: "binding", record: params.observed }]);
  }
  const k = getNodeSqliteKysely<Pick<DB, "worktrees" | "state_leases">>(db);
  const scope = worktreeRunLeaseScope(params.worktreeId);
  const { liveCount, exclusive } = readCurrentWorktreeRunState(db, params.worktreeId);
  if (exclusive || (params.exclusive && liveCount > 0)) {
    throw new Error("The worktree is in use; wait for its current run or publication to finish.");
  }
  const inserted = executeSqliteQuerySync(
    db,
    k
      .insertInto("state_leases")
      .values({
        scope,
        lease_key: params.token,
        owner: `${params.pid}:${params.startTime ?? ""}`,
        expires_at: null,
        heartbeat_at: null,
        payload_json: JSON.stringify({
          pid: params.pid,
          starttime: params.startTime ?? undefined,
          ...(params.exclusive ? { exclusive: true } : {}),
        }),
        created_at: params.now,
        updated_at: params.now,
      })
      .returningAll(),
  ).rows;
  worktreeRegistryPublication.rows(db, inserted);
}

/** Persistent writers recheck the existing removal/publication fence without a perpetual run lease. */
export function assertWorktreePersistentExecutionCurrentInDatabase(
  db: EngineConnection,
  worktreeId: string,
): void {
  if (readCurrentWorktreeRunState(db, worktreeId).exclusive) {
    throw new Error(
      "The worktree has an exclusive publication owner; persistent execution must stop.",
    );
  }
}

function readCurrentWorktreeRunState(db: EngineConnection, worktreeId: string) {
  const k = getNodeSqliteKysely<Pick<DB, "worktrees" | "state_leases">>(db);
  const record = executeSqliteQuerySync(
    db,
    k.selectFrom("worktrees").select(["path", "removed_at"]).where("id", "=", worktreeId),
  ).rows[0];
  const worktreePath = record?.path ?? worktreeId;
  if (!record || record.removed_at != null) {
    throw new Error(`managed worktree was removed: ${worktreePath}`);
  }
  const state = collectLiveRunLeases(db, k, worktreeRunLeaseScope(worktreeId));
  const { removingToken } = state;
  if (removingToken !== undefined) {
    throw new Error(`managed worktree was removed: ${worktreePath}`);
  }
  return state;
}

export function releaseWorktreeRunLeaseInDatabase(
  db: EngineConnection,
  worktreeId: string,
  token: string,
): void {
  const removed = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Pick<DB, "state_leases">>(db)
      .deleteFrom("state_leases")
      .where("scope", "=", worktreeRunLeaseScope(worktreeId))
      .where("lease_key", "=", token)
      .returning(["scope", "lease_key"]),
  ).rows;
  worktreeRegistryPublication.deleted(db, removed);
}
