import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseCurrentReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../../state/openclaw-state-db-readonly.js";
import { tableExists, tableHasColumn } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  getRegistryWorktreeInDatabase,
  getRegistryWorktreeProvisionedStateInDatabase,
  listRegistryWorktreesInDatabase,
  rowToRecord,
  WORKTREE_RECORD_COLUMNS,
} from "./registry-read.kernel.js";
import {
  assertRegistryMutationCustody,
  collectLiveRunLeases,
  worktreeRunLeaseScope,
  WorktreeRemovalContentionError,
  WORKTREE_REMOVING_LEASE_KEY,
  type RunLeaseOwnerChecks,
} from "./run-lease-owner.js";
import { releaseWorktreeRunLeaseInDatabase } from "./run-lease-store.kernel.js";
import type {
  ManagedWorktreeOwnerKind,
  ManagedWorktreeRecord,
  ProvisionedFileState,
} from "./types.js";

export { WorktreeRemovalContentionError } from "./run-lease-owner.js";
export {
  getRegistryWorktreeProvisionedChunk,
  getRegistryWorktreeProvisionedPaths,
  getRegistryWorktreeProvisionedState,
} from "./registry-read.js";

type WorktreesTable = OpenClawStateKyselyDatabase["worktrees"];
type WorktreeRow = Selectable<WorktreesTable>;
type WorktreeRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "worktrees">;
type WorktreeProvisionedDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "worktree_provisioned_file_chunks"
>;
type WorktreeLeaseDatabase = Pick<OpenClawStateKyselyDatabase, "worktrees" | "state_leases">;

function dbFor(env: NodeJS.ProcessEnv): DatabaseSync {
  return openOpenClawStateDatabase({ env }).db;
}

function kyselyFor(db: DatabaseSync) {
  return getNodeSqliteKysely<WorktreeRegistryDatabase>(db);
}

function kyselyProvisionedFor(db: DatabaseSync) {
  return getNodeSqliteKysely<WorktreeProvisionedDatabase>(db);
}

function kyselyLeaseFor(db: DatabaseSync) {
  return getNodeSqliteKysely<WorktreeLeaseDatabase>(db);
}

function recordToRow(
  record: ManagedWorktreeRecord,
  provisionedPaths: readonly string[] | undefined,
): Insertable<WorktreesTable> {
  return {
    id: record.id,
    repo_fingerprint: record.repoFingerprint,
    repo_root: record.repoRoot,
    path: record.path,
    branch: record.branch,
    base_ref: record.baseRef,
    owner_kind: record.ownerKind,
    owner_id: record.ownerId ?? null,
    snapshot_ref: record.snapshotRef ?? null,
    created_at: record.createdAt,
    last_active_at: record.lastActiveAt,
    removed_at: record.removedAt ?? null,
    provisioned_paths_json:
      provisionedPaths === undefined ? null : JSON.stringify(provisionedPaths),
    run_end_cleanup_json:
      record.runEndCleanup === undefined ? null : JSON.stringify(record.runEndCleanup),
  };
}

export function listRegistryWorktrees(env: NodeJS.ProcessEnv): ManagedWorktreeRecord[] {
  return listRegistryWorktreesInDatabase(dbFor(env));
}

export function listRegistryWorktreesForMigration(
  env: NodeJS.ProcessEnv,
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): ManagedWorktreeRecord[] {
  return (
    readRegistry(env, behavior, (db) => {
      const query = kyselyFor(db)
        .selectFrom("worktrees")
        .selectAll()
        .orderBy("created_at", "desc")
        .orderBy("id", "asc");
      return executeSqliteQuerySync(db, query).rows.map(rowToRecord);
    }) ?? []
  );
}

export function listLegacyRegistryWorktreesForMigration(
  env: NodeJS.ProcessEnv,
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): ManagedWorktreeRecord[] {
  return (
    readRegistry(env, behavior, (db) => {
      let query = kyselyFor(db).selectFrom("worktrees").selectAll().orderBy("id", "asc");
      if (tableHasColumn(db, "worktrees", "provisioned_paths_json")) {
        query = query.where("provisioned_paths_json", "is", null);
      }
      return executeSqliteQuerySync(db, query).rows.map(rowToRecord);
    }) ?? []
  );
}

function readRegistry<T>(
  env: NodeJS.ProcessEnv,
  behavior: { artifactPreservingReadOnly?: boolean },
  read: (db: DatabaseSync) => T,
): T | undefined {
  const operation = ({ db }: { db: DatabaseSync }) =>
    tableExists(db, "worktrees") ? read(db) : undefined;
  return behavior.artifactPreservingReadOnly
    ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(operation, { env })
    : withExistingOpenClawStateDatabaseReadOnly(operation, { env });
}

export function getRegistryWorktree(
  env: NodeJS.ProcessEnv,
  id: string,
): ManagedWorktreeRecord | undefined {
  return getRegistryWorktreeInDatabase(dbFor(env), id);
}

export function discardLegacyRegistryWorktrees(
  env: NodeJS.ProcessEnv,
  worktreeIds: readonly string[],
): number {
  if (worktreeIds.length === 0) {
    return 0;
  }
  const db = dbFor(env);
  return runOpenClawStateWriteTransaction(
    () =>
      Number(
        executeSqliteQuerySync(
          db,
          // Delete only the owner rows captured in the migration receipt. A row that
          // appears after planning belongs to the next Doctor run.
          kyselyFor(db)
            .deleteFrom("worktrees")
            .where("provisioned_paths_json", "is", null)
            .where("id", "in", [...worktreeIds]),
        ).numAffectedRows ?? 0n,
      ),
    { env },
  );
}

export function rewriteRegistryWorktreePathsForMigration(
  env: NodeJS.ProcessEnv,
  rewrites: readonly { id: string; fromPath: string; toPath: string }[],
): number {
  if (rewrites.length === 0) {
    return 0;
  }
  const db = dbFor(env);
  // Only the state-migration owner may rewrite persisted worktree identity paths.
  // Runtime updates deliberately keep `path` outside their patch surface.
  return runOpenClawStateWriteTransaction(
    () =>
      rewrites.reduce(
        (count, rewrite) =>
          count +
          Number(
            executeSqliteQuerySync(
              db,
              kyselyFor(db)
                .updateTable("worktrees")
                .set({ path: rewrite.toPath })
                .where("id", "=", rewrite.id)
                .where("path", "=", rewrite.fromPath),
            ).numAffectedRows ?? 0n,
          ),
        0,
      ),
    { env },
  );
}

export function clearRegistryWorktreeProvisionedChunks(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        kyselyProvisionedFor(db)
          .deleteFrom("worktree_provisioned_file_chunks")
          .where("worktree_id", "=", worktreeId),
      );
    },
    { env },
  );
}

export function insertRegistryWorktreeProvisionedChunk(
  env: NodeJS.ProcessEnv,
  params: {
    worktreeId: string;
    path: string;
    chunkIndex: number;
    data: Uint8Array;
  },
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        kyselyProvisionedFor(db).insertInto("worktree_provisioned_file_chunks").values({
          worktree_id: params.worktreeId,
          path: params.path,
          chunk_index: params.chunkIndex,
          data: params.data,
        }),
      );
    },
    { env },
  );
}

export function findLiveRegistryWorktreeByPath(
  env: NodeJS.ProcessEnv,
  worktreePath: string,
): ManagedWorktreeRecord | undefined {
  const db = dbFor(env);
  const query = kyselyFor(db)
    .selectFrom("worktrees")
    .select(WORKTREE_RECORD_COLUMNS)
    .where("path", "=", worktreePath)
    .where("removed_at", "is", null)
    .orderBy("created_at", "desc")
    .limit(1);
  const row = executeSqliteQuerySync(db, query).rows[0];
  return row ? rowToRecord(row) : undefined;
}

export function findLiveRegistryWorktreeByOwner(
  env: NodeJS.ProcessEnv,
  ownerKind: ManagedWorktreeOwnerKind,
  ownerId: string,
): ManagedWorktreeRecord | undefined {
  const db = dbFor(env);
  const query = kyselyFor(db)
    .selectFrom("worktrees")
    .select(WORKTREE_RECORD_COLUMNS)
    .where("owner_kind", "=", ownerKind)
    .where("owner_id", "=", ownerId)
    .where("removed_at", "is", null)
    .orderBy("created_at", "desc")
    .limit(1);
  const row = executeSqliteQuerySync(db, query).rows[0];
  return row ? rowToRecord(row) : undefined;
}

export function insertRegistryWorktree(
  env: NodeJS.ProcessEnv,
  record: ManagedWorktreeRecord,
  options: { provisionedPaths?: readonly string[] } = {},
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        kyselyFor(db).insertInto("worktrees").values(recordToRow(record, options.provisionedPaths)),
      );
    },
    { env },
  );
}

export function updateRegistryWorktree(
  env: NodeJS.ProcessEnv,
  id: string,
  patch: Partial<
    Pick<ManagedWorktreeRecord, "lastActiveAt" | "removedAt" | "runEndCleanup" | "snapshotRef">
  > & {
    repositoryIdentity?: Pick<ManagedWorktreeRecord, "repoRoot" | "repoFingerprint">;
    provisionedPaths?: readonly string[];
    provisionedState?: readonly ProvisionedFileState[];
  },
  options: {
    onlyIfLive?: boolean;
    onlyIfActiveAt?: number;
    assertCurrent?: () => void;
    removalToken?: string;
  } = {},
): void {
  const values: Partial<WorktreeRow> = {};
  if (patch.lastActiveAt !== undefined) {
    values.last_active_at = patch.lastActiveAt;
  }
  if ("removedAt" in patch) {
    values.removed_at = patch.removedAt ?? null;
  }
  if ("snapshotRef" in patch) {
    values.snapshot_ref = patch.snapshotRef ?? null;
  }
  if ("runEndCleanup" in patch) {
    values.run_end_cleanup_json =
      patch.runEndCleanup === undefined ? null : JSON.stringify(patch.runEndCleanup);
  }
  if (patch.repositoryIdentity) {
    values.repo_root = patch.repositoryIdentity.repoRoot;
    values.repo_fingerprint = patch.repositoryIdentity.repoFingerprint;
  }
  if (patch.provisionedState !== undefined) {
    values.provisioned_paths_json = JSON.stringify(patch.provisionedState);
  } else if (patch.provisionedPaths !== undefined) {
    values.provisioned_paths_json = JSON.stringify(patch.provisionedPaths);
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // Revalidate under the immediate write transaction, excluding cross-process lifecycle writers.
      options.assertCurrent?.();
      assertRegistryMutationCustody(db, kyselyLeaseFor(db), id, options.removalToken);
      let update = kyselyFor(db).updateTable("worktrees").set(values).where("id", "=", id);
      // Busy/retained/failed outcomes are authoritative only for the lifecycle the
      // writer observed: the live condition blocks post-finalization overwrites, and
      // the activity condition blocks prior-lifecycle writes after a concurrent
      // remove-plus-restore revives the row (restore bumps last_active_at).
      if (options.onlyIfLive) {
        update = update.where("removed_at", "is", null);
      }
      if (options.onlyIfActiveAt !== undefined) {
        update = update.where("last_active_at", "=", options.onlyIfActiveAt);
      }
      executeSqliteQuerySync(db, update);
    },
    { env },
  );
}

/** Retired snapshots cannot discard provisioned data or another lifecycle's custody. */
function assertSnapshotRetirementInDatabase(
  db: DatabaseSync,
  observed: ManagedWorktreeRecord,
): void {
  const row = executeSqliteQuerySync(
    db,
    kyselyFor(db).selectFrom("worktrees").selectAll().where("id", "=", observed.id),
  ).rows[0];
  if (
    observed.removedAt === undefined ||
    !row ||
    JSON.stringify(rowToRecord(row)) !== JSON.stringify(observed)
  ) {
    throw new Error("Worktree snapshot retirement identity changed");
  }
  const provisioned = getRegistryWorktreeProvisionedStateInDatabase(db, observed.id);
  const chunk = executeSqliteQuerySync(
    db,
    kyselyProvisionedFor(db)
      .selectFrom("worktree_provisioned_file_chunks")
      .select("worktree_id")
      .where("worktree_id", "=", observed.id)
      .limit(1),
  ).rows[0];
  if (provisioned === undefined || provisioned.length !== 0 || chunk) {
    throw new Error("Worktree snapshot retains provisioned data; retain its custody");
  }
  const leases = collectLiveRunLeases(
    db,
    kyselyLeaseFor(db),
    worktreeRunLeaseScope(observed.id),
    {},
  );
  if (leases.liveCount !== 0 || leases.removingToken !== undefined) {
    throw new Error("Worktree snapshot has an active or unresolved run/removal consumer");
  }
}

export function assertRegistrySnapshotRetirement(
  env: NodeJS.ProcessEnv,
  observed: ManagedWorktreeRecord,
): void {
  runOpenClawStateWriteTransaction(({ db }) => assertSnapshotRetirementInDatabase(db, observed), {
    env,
  });
}

export function deleteRegistryWorktree(
  env: NodeJS.ProcessEnv,
  id: string,
  options: {
    assertCurrent?: () => void;
    removalToken?: string;
    expectedRetired?: ManagedWorktreeRecord;
  } = {},
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // Validate before deleting either the record or its provisioned recovery chunks.
      options.assertCurrent?.();
      if (options.expectedRetired) {
        if (options.expectedRetired.id !== id) {
          throw new Error("Worktree snapshot retirement ID changed");
        }
        assertSnapshotRetirementInDatabase(db, options.expectedRetired);
      }
      assertRegistryMutationCustody(db, kyselyLeaseFor(db), id, options.removalToken);
      executeSqliteQuerySync(
        db,
        kyselyProvisionedFor(db)
          .deleteFrom("worktree_provisioned_file_chunks")
          .where("worktree_id", "=", id),
      );
      executeSqliteQuerySync(db, kyselyFor(db).deleteFrom("worktrees").where("id", "=", id));
    },
    { env },
  );
}

export function retireMissingRegistryWorktree(
  env: NodeJS.ProcessEnv,
  observed: Pick<
    ManagedWorktreeRecord,
    "id" | "path" | "lastActiveAt" | "repoRoot" | "repoFingerprint"
  >,
  removedAt: number,
): ManagedWorktreeRecord | undefined {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      // A path probe cannot retire a restored lifecycle or a rebound repository.
      const retired = executeSqliteQuerySync(
        db,
        kyselyFor(db)
          .updateTable("worktrees")
          .set({ removed_at: removedAt })
          .where("id", "=", observed.id)
          .where("removed_at", "is", null)
          // A private exact-state retirement path may still hold the complete
          // source. Only its explicit recovery owner can finalize that lifecycle.
          .where((eb) =>
            eb.or([
              eb("snapshot_ref", "is", null),
              eb("snapshot_ref", "not like", "refs/openclaw/snapshots/exact-%"),
            ]),
          )
          .where("path", "=", observed.path)
          .where("last_active_at", "=", observed.lastActiveAt)
          .where("repo_root", "=", observed.repoRoot)
          .where("repo_fingerprint", "=", observed.repoFingerprint)
          .returning(WORKTREE_RECORD_COLUMNS),
      ).rows[0];
      const current =
        retired ??
        executeSqliteQuerySync(
          db,
          kyselyFor(db)
            .selectFrom("worktrees")
            .select(WORKTREE_RECORD_COLUMNS)
            .where("id", "=", observed.id),
        ).rows[0];
      return current ? rowToRecord(current) : undefined;
    },
    { env },
  );
}

export function admitWorktreeRunLeaseRow(
  env: NodeJS.ProcessEnv,
  params: {
    worktreeId: string;
    token: string;
    pid: number;
    startTime: number | null;
    now: number;
    checks?: RunLeaseOwnerChecks;
    exclusive?: true;
  },
): void {
  runOpenClawStateWriteTransaction(
    (database) => {
      const db = database.db;
      const k = kyselyLeaseFor(db);
      const scope = worktreeRunLeaseScope(params.worktreeId);
      const record = executeSqliteQuerySync(
        db,
        k
          .selectFrom("worktrees")
          .select(["path", "removed_at"])
          .where("id", "=", params.worktreeId),
      ).rows[0];
      const worktreePath = record?.path ?? params.worktreeId;
      if (!record || record.removed_at != null) {
        throw new Error(`managed worktree was removed: ${worktreePath}`);
      }
      const { removingToken, liveCount, exclusive } = collectLiveRunLeases(
        db,
        k,
        scope,
        params.checks ?? {},
      );
      if (removingToken !== undefined) {
        throw new Error(`managed worktree was removed: ${worktreePath}`);
      }
      if (exclusive || (params.exclusive && liveCount > 0)) {
        throw new Error(
          "The worktree is in use; wait for its current run or publication to finish.",
        );
      }
      executeSqliteQuerySync(
        db,
        k.insertInto("state_leases").values({
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
        }),
      );
    },
    { env },
  );
}

export function claimWorktreeRemovalRow(
  env: NodeJS.ProcessEnv,
  params: {
    worktreeId: string;
    token: string;
    pid: number;
    startTime: number | null;
    now: number;
    checks?: RunLeaseOwnerChecks;
    retiredExact?: true;
    retiredRemoval?: true;
    assertCurrent?: () => void;
  },
): void {
  runOpenClawStateWriteTransaction(
    (database) => {
      params.assertCurrent?.();
      const db = database.db;
      const k = kyselyLeaseFor(db);
      const scope = worktreeRunLeaseScope(params.worktreeId);
      const record = executeSqliteQuerySync(
        db,
        k
          .selectFrom("worktrees")
          .select(["id", "path", "removed_at", "snapshot_ref"])
          .where("id", "=", params.worktreeId),
      ).rows[0];
      if (
        !record ||
        (params.retiredRemoval
          ? record.removed_at == null ||
            record.snapshot_ref !== `refs/openclaw/snapshots/${params.worktreeId}`
          : params.retiredExact
            ? record.removed_at == null ||
              !record.snapshot_ref?.startsWith("refs/openclaw/snapshots/exact-")
            : record.removed_at != null)
      ) {
        throw new WorktreeRemovalContentionError(
          "finalized",
          `managed worktree was removed: ${record?.path ?? params.worktreeId}`,
        );
      }
      const { livePids, removingToken } = collectLiveRunLeases(db, k, scope, params.checks ?? {});
      if (livePids.length > 0) {
        throw new WorktreeRemovalContentionError(
          "busy",
          `worktree is busy: locked by live pid ${livePids[0]}`,
        );
      }
      // The removal claim is exclusive: a live marker owned by a different token means
      // another remover is mid-operation, so this remover must not enter it too.
      if (removingToken !== undefined && removingToken !== params.token) {
        throw new WorktreeRemovalContentionError("busy", "worktree removal is already in progress");
      }
      const payloadJson = JSON.stringify({
        pid: params.pid,
        starttime: params.startTime ?? undefined,
      });
      executeSqliteQuerySync(
        db,
        k
          .insertInto("state_leases")
          .values({
            scope,
            lease_key: WORKTREE_REMOVING_LEASE_KEY,
            owner: params.token,
            expires_at: null,
            heartbeat_at: null,
            payload_json: payloadJson,
            created_at: params.now,
            updated_at: params.now,
          })
          .onConflict((conflict) =>
            conflict.columns(["scope", "lease_key"]).doUpdateSet({
              owner: params.token,
              payload_json: payloadJson,
              updated_at: params.now,
            }),
          ),
      );
    },
    { env },
  );
}

/** Synchronous lock primitive: a lost removal claim must never be reacquired implicitly. */
export function assertWorktreeRemovalClaim(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  token: string,
): void {
  const db = dbFor(env);
  const row = executeSqliteQuerySync(
    db,
    kyselyLeaseFor(db)
      .selectFrom("state_leases")
      .select("owner")
      .where("scope", "=", worktreeRunLeaseScope(worktreeId))
      .where("lease_key", "=", WORKTREE_REMOVING_LEASE_KEY),
  ).rows[0];
  if (row?.owner !== token) {
    throw new WorktreeRemovalContentionError(
      "busy",
      "Worktree removal claim changed; checkout preserved",
    );
  }
}

export function releaseWorktreeRunLeaseRow(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  token: string,
): void {
  // Process exit cannot await the worker. Runtime cleanup uses its async command.
  runOpenClawStateWriteTransaction(
    ({ db }) => releaseWorktreeRunLeaseInDatabase(db, worktreeId, token),
    { env },
    { operationLabel: "worktrees.releaseRunLease" },
  );
}

export function finalizeWorktreeRemovalRows(env: NodeJS.ProcessEnv, worktreeId: string): void {
  const db = dbFor(env);
  runOpenClawStateWriteTransaction(
    () => {
      executeSqliteQuerySync(
        db,
        kyselyLeaseFor(db)
          .deleteFrom("state_leases")
          .where("scope", "=", worktreeRunLeaseScope(worktreeId)),
      );
    },
    { env },
  );
}

export function abortWorktreeRemovalRow(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  token: string,
): void {
  const db = dbFor(env);
  runOpenClawStateWriteTransaction(
    () => {
      // Owner-scoped: only the claim that still owns the marker may clear it, so a slow
      // remover cannot delete a marker a newer remover established after replacing it.
      executeSqliteQuerySync(
        db,
        kyselyLeaseFor(db)
          .deleteFrom("state_leases")
          .where("scope", "=", worktreeRunLeaseScope(worktreeId))
          .where("lease_key", "=", WORKTREE_REMOVING_LEASE_KEY)
          .where("owner", "=", token),
      );
    },
    { env },
  );
}

export function hasLiveWorktreeRunLeaseRow(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  checks?: RunLeaseOwnerChecks,
): boolean {
  return (
    withExistingOpenClawStateDatabaseCurrentReadOnly(
      ({ db }) =>
        collectLiveRunLeases(
          db,
          kyselyLeaseFor(db),
          worktreeRunLeaseScope(worktreeId),
          checks ?? {},
          false,
        ).livePids.length > 0,
      { env },
    ) ?? false
  );
}
