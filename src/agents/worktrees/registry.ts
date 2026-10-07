import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
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
import { WorktreeRemovalContentionError } from "./errors.js";
import {
  findLiveRegistryWorktreeByOwnerInDatabase,
  findLiveRegistryWorktreeByPathInDatabase,
  getRegistryWorktreeInDatabase,
  getRegistryWorktreeProvisionedStateInDatabase,
  listRegistryWorktreesInDatabase,
  rowToRecord,
} from "./registry-read.kernel.js";
import { runWorktreeRunEndCommand } from "./registry-run-end.js";
import type { WorktreeRegistryPatch } from "./registry-run-end.worker.js";
import { captureWorktreeRunEndContext } from "./run-end-lifecycle.js";
import {
  assertRegistryMutationCustody,
  collectLiveRunLeases,
  worktreeRunLeaseScope,
  WORKTREE_REMOVING_LEASE_KEY,
} from "./run-lease-owner.js";
import { releaseWorktreeRunLeaseInDatabase } from "./run-lease-store.kernel.js";
import type {
  ManagedWorktreeOwnerKind,
  ManagedWorktreeRecord,
  WorktreeWorkerAuthority,
} from "./types.js";

export { WorktreeRemovalContentionError } from "./errors.js";
export {
  claimWorktreeRemovalRow,
  finalizeWorktreeRemovalRows,
  abortWorktreeRemovalRow,
} from "./registry-run-end.js";
export { clearRegistryWorktreeProvisionedChunks } from "./provisioned-snapshot-store.js";
export {
  getRegistryWorktreeProvisionedPaths,
  getRegistryWorktreeProvisionedState,
} from "./registry-read.js";

type WorktreeRegistryDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "worktrees" | "worktree_provisioned_file_chunks" | "state_leases"
>;

function dbFor(env: NodeJS.ProcessEnv): DatabaseSync {
  return openOpenClawStateDatabase({ env }).db;
}

function kyselyFor(db: DatabaseSync) {
  return getNodeSqliteKysely<WorktreeRegistryDatabase>(db);
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

export function findLiveRegistryWorktreeByPath(
  env: NodeJS.ProcessEnv,
  worktreePath: string,
): ManagedWorktreeRecord | undefined {
  return findLiveRegistryWorktreeByPathInDatabase(dbFor(env), worktreePath);
}

export function findLiveRegistryWorktreeByOwner(
  env: NodeJS.ProcessEnv,
  ownerKind: ManagedWorktreeOwnerKind,
  ownerId: string,
): ManagedWorktreeRecord | undefined {
  return findLiveRegistryWorktreeByOwnerInDatabase(dbFor(env), ownerKind, ownerId);
}

export function insertRegistryWorktree(
  env: NodeJS.ProcessEnv,
  record: ManagedWorktreeRecord,
  options: {
    provisionedPaths?: readonly string[];
    workerAuthority?: WorktreeWorkerAuthority;
    pendingId?: string;
  } = {},
): Promise<void> {
  return runWorktreeRunEndCommand(
    captureWorktreeRunEndContext(env),
    {
      type: "worktrees.insert",
      input: {
        value: { record, provisionedPaths: options.provisionedPaths, pendingId: options.pendingId },
        receipt: randomUUID(),
      },
    },
    options.workerAuthority,
  );
}

export function updateRegistryWorktree(
  env: NodeJS.ProcessEnv,
  id: string,
  patch: WorktreeRegistryPatch,
  options: {
    onlyIfLive?: boolean;
    onlyIfActiveAt?: number;
    assertCurrent?: () => void;
    removalToken?: string;
    workerAuthority?: WorktreeWorkerAuthority;
  } = {},
): Promise<void> {
  const { assertCurrent, workerAuthority, ...conditions } = options;
  return runWorktreeRunEndCommand(
    captureWorktreeRunEndContext(env),
    {
      type: "worktrees.update",
      input: { value: { id, patch, ...conditions }, receipt: randomUUID() },
    },
    workerAuthority ?? { assertCurrent },
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
    kyselyFor(db)
      .selectFrom("worktree_provisioned_file_chunks")
      .select("worktree_id")
      .where("worktree_id", "=", observed.id)
      .limit(1),
  ).rows[0];
  if (provisioned === undefined || provisioned.length !== 0 || chunk) {
    throw new Error("Worktree snapshot retains provisioned data; retain its custody");
  }
  const leases = collectLiveRunLeases(db, kyselyFor(db), worktreeRunLeaseScope(observed.id));
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
      assertRegistryMutationCustody(db, kyselyFor(db), id, options.removalToken);
      executeSqliteQuerySync(
        db,
        kyselyFor(db).deleteFrom("worktree_provisioned_file_chunks").where("worktree_id", "=", id),
      );
      executeSqliteQuerySync(db, kyselyFor(db).deleteFrom("worktrees").where("id", "=", id));
    },
    { env },
  );
}

/** Batch lock-primitive read: one JSON binding avoids per-claim SQL and SQLite bind limits. */
export function createWorktreeRemovalClaimsGuard(
  env: NodeJS.ProcessEnv,
  worktreeIds: readonly string[],
  token: string,
): () => void {
  const ids = [...new Set(worktreeIds)];
  const count = ids.length;
  const scopes = sqliteStringSet(ids.map(worktreeRunLeaseScope));
  return () => {
    if (count === 0) {
      return;
    }
    const db = dbFor(env);
    const held = executeSqliteQuerySync(
      db,
      kyselyFor(db)
        .selectFrom("state_leases")
        .select((eb) => eb.fn.countAll<number>().as("held"))
        .where("state_leases.scope", "in", scopes)
        .where("state_leases.lease_key", "=", WORKTREE_REMOVING_LEASE_KEY)
        .where("state_leases.owner", "=", token),
    ).rows[0]?.held;
    if (held !== count) {
      throw new WorktreeRemovalContentionError(
        "busy",
        "Worktree removal claim changed; checkout preserved",
      );
    }
  };
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

/** Check removal custody before a session mutation waits for checkout allocation. */
export function assertWorktreeRemovalAvailable(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  ownToken?: string,
): void {
  const db = dbFor(env);
  const token = collectLiveRunLeases(
    db,
    kyselyFor(db),
    worktreeRunLeaseScope(worktreeId),
    false,
  ).removingToken;
  if (token !== undefined && token !== ownToken) {
    throw new WorktreeRemovalContentionError(
      "busy",
      "Worktree removal is in progress; retry after cleanup settles",
    );
  }
}

export function hasLiveWorktreeRunLeaseRow(env: NodeJS.ProcessEnv, worktreeId: string): boolean {
  return (
    withExistingOpenClawStateDatabaseCurrentReadOnly(
      ({ db }) =>
        collectLiveRunLeases(db, kyselyFor(db), worktreeRunLeaseScope(worktreeId), false).livePids
          .length > 0,
      { env },
    ) ?? false
  );
}
