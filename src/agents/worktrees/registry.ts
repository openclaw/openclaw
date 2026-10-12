import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { withStateDatabaseSchemaMaintenance } from "../../infra/state-database-maintenance.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../../state/openclaw-state-db-readonly.js";
import { tableExists, tableHasColumn } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { WorktreeRemovalContentionError } from "./errors.js";
import { worktreeRegistryPublication } from "./registry-publication.js";
import { rowToRecord } from "./registry-read.kernel.js";
import { runWorktreeRunEndCommand } from "./registry-run-end.js";
import type { WorktreeRegistryPatch } from "./registry-run-end.worker.js";
import {
  captureWorktreeRegistryMutation,
  captureWorktreeRunEndContext,
} from "./run-end-lifecycle.js";
import {
  collectLiveRunLeases,
  worktreeRunLeaseScope,
  WORKTREE_REMOVING_LEASE_KEY,
} from "./run-lease-owner.js";
import { releaseWorktreeRunLeaseInDatabase } from "./run-lease-store.kernel.js";
import type { ManagedWorktreeRecord, WorktreeWorkerAuthority } from "./types.js";

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

// Doctor/startup planning may release schema custody before these native business writes.
function runRegistryMigration(
  write: (db: DatabaseSync) => number,
  { env }: { env: NodeJS.ProcessEnv },
): number {
  return withStateDatabaseSchemaMaintenance(
    { databasePath: resolveOpenClawStateSqlitePath(env) },
    () => runOpenClawStateWriteTransaction(({ db }) => write(db), { env }),
  );
}

export function discardLegacyRegistryWorktrees(
  env: NodeJS.ProcessEnv,
  worktreeIds: readonly string[],
): number {
  if (worktreeIds.length === 0) {
    return 0;
  }
  return runRegistryMigration(
    (db) => {
      const removed = executeSqliteQuerySync(
        db,
        // Delete only the owner rows captured in the migration receipt. A row that
        // appears after planning belongs to the next Doctor run.
        kyselyFor(db)
          .deleteFrom("worktrees")
          .where("provisioned_paths_json", "is", null)
          .where("id", "in", [...worktreeIds])
          .returningAll(),
      ).rows;
      worktreeRegistryPublication.deleted(db, removed);
      return removed.length;
    },
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
  // Only the state-migration owner may rewrite persisted worktree identity paths.
  // Runtime updates deliberately keep `path` outside their patch surface.
  return runRegistryMigration(
    (db) =>
      rewrites.reduce((count, rewrite) => {
        const changed = executeSqliteQuerySync(
          db,
          kyselyFor(db)
            .updateTable("worktrees")
            .set({ path: rewrite.toPath })
            .where("id", "=", rewrite.id)
            .where("path", "=", rewrite.fromPath)
            .returningAll(),
        ).rows;
        worktreeRegistryPublication.rows(db, changed);
        return count + changed.length;
      }, 0),
    { env },
  );
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

export function deleteRegistryWorktree(
  env: NodeJS.ProcessEnv,
  id: string,
  options: {
    assertCurrent?: () => void;
    removalToken?: string;
    expectedRetired?: ManagedWorktreeRecord;
    workerAuthority?: WorktreeWorkerAuthority;
  } = {},
): Promise<void> {
  return runWorktreeRunEndCommand(
    captureWorktreeRunEndContext(env),
    {
      type: "worktrees.delete",
      input: {
        value: { id, removalToken: options.removalToken, expectedRetired: options.expectedRetired },
        receipt: randomUUID(),
      },
    },
    options.workerAuthority ?? { assertCurrent: options.assertCurrent },
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
  const mutation = captureWorktreeRegistryMutation(
    captureWorktreeRunEndContext(env),
    [{ id: worktreeId, fields: ["leases"] }],
    { settlement: true },
  );
  mutation.observeTransaction();
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => releaseWorktreeRunLeaseInDatabase(db, worktreeId, token),
      { env },
      { operationLabel: "worktrees.releaseRunLease" },
    );
  } finally {
    mutation.settle(false);
  }
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
