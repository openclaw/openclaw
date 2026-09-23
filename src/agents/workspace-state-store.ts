import { existsSync } from "node:fs";
import path from "node:path";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveUserPath } from "../utils.js";
import { retireWorkspaceFileCache } from "./workspace-file-cache.js";
import {
  createWorkspaceStateIdentity,
  resolveCanonicalWorkspacePath,
  resolveWorkspaceStateAliases,
  resolveWorkspaceStateIdentity,
  WorkspaceAliasRepointedError,
  type WorkspaceStateIdentity,
} from "./workspace-state-identity.js";
import {
  assertCanonicalIntegerTimestamp,
  assertCanonicalTimestamp,
  isSafeWorkspaceAttestationFilename,
  readWorkspaceStateSnapshotFromDatabase,
  registerWorkspaceStateAliasIdentitiesInTransaction,
  resolveWorkspaceIdentityFromDatabase,
  SHA256_HEX_PATTERN,
  WORKSPACE_ATTESTATION_RECENT_MS,
  WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND,
  WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
  WORKSPACE_SETUP_STATE_VERSION,
  workspacePathEntryExists,
  type WorkspaceAttestation,
  type WorkspaceSetupState,
  type WorkspaceStateDatabase,
  type WorkspaceStateDatabaseHandle,
  type WorkspaceStateSnapshot,
} from "./workspace-state-store.kernel.js";

export {
  isSafeWorkspaceAttestationFilename,
  readWorkspaceStateSnapshotFromDatabase,
  registerWorkspaceStateAliasIdentitiesInTransaction,
  registerWorkspaceStateAliasesInTransaction,
  WORKSPACE_ATTESTATION_RECENT_MS,
  WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND,
  WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
  WORKSPACE_SETUP_STATE_VERSION,
  type WorkspaceAttestation,
  type WorkspaceSetupState,
  type WorkspaceStateSnapshot,
} from "./workspace-state-store.kernel.js";

type WorkspaceStateOperationOptions = { assertCurrent?: () => void };

type WorkspaceStateDeletionPlan = {
  cacheRoot: string;
  lexicalAlias: WorkspaceStateIdentity;
  currentCanonicalIdentity: WorkspaceStateIdentity;
  pathEntryExisted: boolean;
};

export async function readWorkspaceStateSnapshot(
  workspaceDir: string,
  options: OpenClawStateDatabaseOptions & WorkspaceStateOperationOptions = {},
): Promise<WorkspaceStateSnapshot> {
  if (options.readOnly) {
    const capturedWorkspaceDir = path.resolve(resolveUserPath(workspaceDir));
    const reply = await executeExistingOpenClawStateRead(options, {
      type: "workspace.snapshot",
      workspaceDir: capturedWorkspaceDir,
    });
    if (reply && (!reply.ok || reply.type !== "workspace.snapshot")) {
      throw new Error("Unexpected workspace state snapshot result");
    }
    return (
      reply?.snapshot ?? {
        identity: resolveWorkspaceStateIdentity(capturedWorkspaceDir),
        setupExists: false,
        setup: { version: WORKSPACE_SETUP_STATE_VERSION },
      }
    );
  }
  const database = openOpenClawStateDatabase(options);
  const initial = runSqliteDeferredTransactionSync(database.db, () => {
    const resolution = resolveWorkspaceIdentityFromDatabase({ workspaceDir, database });
    return {
      resolution,
      snapshot: readWorkspaceStateSnapshotFromDatabase({ identity: resolution.identity, database }),
    };
  });
  if (
    initial.resolution.missingAliasKeys.length === 0 ||
    (!initial.snapshot.setupExists && !initial.snapshot.attestation)
  ) {
    return initial.snapshot;
  }
  // Register a newly observed configured spelling once state proves the target
  // identity. Later disappearance must still find the same safety evidence.
  return runOpenClawStateWriteTransaction((writeDatabase) => {
    options.assertCurrent?.();
    const currentAliases = resolveWorkspaceStateAliases(workspaceDir);
    const currentCanonicalIdentity = currentAliases.at(-1)!;
    if (
      workspacePathEntryExists(workspaceDir) &&
      currentCanonicalIdentity.workspaceKey !== initial.resolution.identity.workspaceKey
    ) {
      throw new WorkspaceAliasRepointedError({
        aliasPath: currentAliases[0]!.workspacePath,
        storedWorkspacePath: initial.resolution.identity.workspacePath,
        currentWorkspacePath: currentCanonicalIdentity.workspacePath,
      });
    }
    const snapshot = readWorkspaceStateSnapshotFromDatabase({
      identity: initial.resolution.identity,
      database: writeDatabase,
    });
    if (snapshot.setupExists || snapshot.attestation) {
      const aliases = new Map(
        [...initial.resolution.aliases, ...currentAliases].map((alias) => [
          alias.workspaceKey,
          alias,
        ]),
      );
      registerWorkspaceStateAliasIdentitiesInTransaction({
        database: writeDatabase,
        identity: initial.resolution.identity,
        aliases: [...aliases.values()],
        updatedAtMs: Date.now(),
      });
    }
    return snapshot;
  }, options);
}

export async function mergeWorkspaceSetupState(
  workspaceDir: string,
  next: Partial<Omit<WorkspaceSetupState, "version">>,
  nowMs = Date.now(),
  options: OpenClawStateDatabaseOptions & WorkspaceStateOperationOptions = {},
): Promise<WorkspaceSetupState> {
  assertCanonicalIntegerTimestamp(nowMs, "setup update");
  if (next.bootstrapSeededAt) {
    assertCanonicalTimestamp(next.bootstrapSeededAt, "bootstrap seeded");
  }
  if (next.setupCompletedAt) {
    assertCanonicalTimestamp(next.setupCompletedAt, "setup completed");
  }
  return runOpenClawStateWriteTransaction((database) => {
    options.assertCurrent?.();
    const resolution = resolveWorkspaceIdentityFromDatabase({ workspaceDir, database });
    const identity = resolution.identity;
    const snapshot = readWorkspaceStateSnapshotFromDatabase({ identity, database });
    const bootstrapSeededAt = snapshot.setup.bootstrapSeededAt ?? next.bootstrapSeededAt;
    const setupCompletedAt = snapshot.setup.setupCompletedAt ?? next.setupCompletedAt;
    const merged: WorkspaceSetupState = {
      version: WORKSPACE_SETUP_STATE_VERSION,
      ...(bootstrapSeededAt ? { bootstrapSeededAt } : {}),
      ...(setupCompletedAt ? { setupCompletedAt } : {}),
    };
    const kysely = getNodeSqliteKysely<WorkspaceStateDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      kysely
        .insertInto("workspace_setup_state")
        .values({
          workspace_key: identity.workspaceKey,
          workspace_path: identity.workspacePath,
          version: WORKSPACE_SETUP_STATE_VERSION,
          bootstrap_seeded_at: merged.bootstrapSeededAt ?? null,
          setup_completed_at: merged.setupCompletedAt ?? null,
          updated_at: nowMs,
        })
        .onConflict((conflict) =>
          conflict.column("workspace_key").doUpdateSet({
            workspace_path: identity.workspacePath,
            version: WORKSPACE_SETUP_STATE_VERSION,
            bootstrap_seeded_at: merged.bootstrapSeededAt ?? null,
            setup_completed_at: merged.setupCompletedAt ?? null,
            updated_at: nowMs,
          }),
        ),
    );
    registerWorkspaceStateAliasIdentitiesInTransaction({
      database,
      identity,
      aliases: resolution.aliases,
      updatedAtMs: nowMs,
    });
    return merged;
  }, options);
}

export async function replaceWorkspaceAttestation(
  params: {
    workspaceDir: string;
    attestedAtMs: number;
    generatedHashes: ReadonlyMap<string, string>;
    nowMs?: number;
  } & WorkspaceStateOperationOptions,
): Promise<WorkspaceAttestation> {
  assertCanonicalIntegerTimestamp(params.attestedAtMs, "attestation");
  if (params.nowMs !== undefined) {
    assertCanonicalIntegerTimestamp(params.nowMs, "attestation update");
  }
  for (const [filename, sha256] of params.generatedHashes) {
    if (!isSafeWorkspaceAttestationFilename(filename) || !SHA256_HEX_PATTERN.test(sha256)) {
      throw new Error("workspace attestation hash is invalid");
    }
  }
  const sortedHashes = [...params.generatedHashes.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  return runOpenClawStateWriteTransaction((database) => {
    params.assertCurrent?.();
    // Capture the comparison clock only after BEGIN IMMEDIATE acquires the
    // writer lock, so a newer committed row cannot look future-dated.
    const updatedAtMs = params.nowMs ?? Date.now();
    assertCanonicalIntegerTimestamp(updatedAtMs, "attestation update");
    const resolution = resolveWorkspaceIdentityFromDatabase({
      workspaceDir: params.workspaceDir,
      database,
    });
    const identity = resolution.identity;
    const snapshot = readWorkspaceStateSnapshotFromDatabase({ identity, database });
    if (
      snapshot.attestation &&
      snapshot.attestation.attestedAtMs > params.attestedAtMs &&
      snapshot.attestation.attestedAtMs <= updatedAtMs
    ) {
      registerWorkspaceStateAliasIdentitiesInTransaction({
        database,
        identity,
        aliases: resolution.aliases,
        updatedAtMs,
      });
      return snapshot.attestation;
    }
    const kysely = getNodeSqliteKysely<WorkspaceStateDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      kysely
        .insertInto("workspace_setup_state")
        .values({
          workspace_key: identity.workspaceKey,
          workspace_path: identity.workspacePath,
          attested_at_ms: params.attestedAtMs,
          attestation_updated_at_ms: updatedAtMs,
        })
        .onConflict((conflict) =>
          conflict.column("workspace_key").doUpdateSet({
            // Heals the NULL path on adopted legacy orphan attestation rows.
            workspace_path: identity.workspacePath,
            attested_at_ms: params.attestedAtMs,
            attestation_updated_at_ms: updatedAtMs,
          }),
        ),
    );
    executeSqliteQuerySync(
      database.db,
      kysely
        .deleteFrom("workspace_generated_bootstrap_hashes")
        .where("workspace_key", "=", identity.workspaceKey),
    );
    if (sortedHashes.length > 0) {
      executeSqliteQuerySync(
        database.db,
        kysely.insertInto("workspace_generated_bootstrap_hashes").values(
          sortedHashes.map(([filename, sha256]) => ({
            workspace_key: identity.workspaceKey,
            filename,
            sha256,
          })),
        ),
      );
    }
    registerWorkspaceStateAliasIdentitiesInTransaction({
      database,
      identity,
      aliases: resolution.aliases,
      updatedAtMs,
    });
    return {
      attestedAtMs: params.attestedAtMs,
      generatedHashes: new Map(sortedHashes),
    };
  });
}

function deleteWorkspaceRows(
  database: WorkspaceStateDatabaseHandle,
  { workspaceKey, workspacePath }: WorkspaceStateIdentity,
): void {
  const kysely = getNodeSqliteKysely<WorkspaceStateDatabase>(database.db);
  const receiptRows = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("migration_sources")
      .select(["source_key", "last_run_id", "report_json"])
      .where("migration_kind", "in", [
        WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
        WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND,
      ]),
  ).rows.filter((row) => {
    try {
      const report = JSON.parse(row.report_json) as Record<string, unknown>;
      return report.workspaceKey === workspaceKey;
    } catch {
      return false;
    }
  });
  if (receiptRows.length > 0) {
    const receiptKeys = receiptRows.map((row) => row.source_key);
    executeSqliteQuerySync(
      database.db,
      kysely.deleteFrom("migration_sources").where("source_key", "in", receiptKeys),
    );
    const runIds = [...new Set(receiptRows.map((row) => row.last_run_id))];
    const referencedRunIds = new Set(
      executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("migration_sources")
          .select("last_run_id")
          .where("last_run_id", "in", runIds),
      ).rows.map((row) => row.last_run_id),
    );
    const orphanedRunIds = runIds.filter((runId) => !referencedRunIds.has(runId));
    if (orphanedRunIds.length > 0) {
      executeSqliteQuerySync(
        database.db,
        kysely.deleteFrom("migration_runs").where("id", "in", orphanedRunIds),
      );
    }
  }
  executeSqliteQuerySync(
    database.db,
    kysely
      .deleteFrom("workspace_generated_bootstrap_hashes")
      .where("workspace_key", "=", workspaceKey),
  );
  executeSqliteQuerySync(
    database.db,
    kysely.deleteFrom("workspace_setup_state").where("workspace_key", "=", workspaceKey),
  );
  executeSqliteQuerySync(
    database.db,
    kysely.deleteFrom("workspace_path_aliases").where("workspace_key", "=", workspaceKey),
  );
  // Both deletion paths retire the actual stored identity only after the outer
  // commit; a failed transaction must retain content for the surviving workspace.
  deferSqlitePostCommitPublication(database.db, () => retireWorkspaceFileCache(workspacePath));
}

/** The migration owner has verified the same workspace and every relocated byte before this commit. */
export function retireWorkspaceRelocationAttestation(params: {
  database: WorkspaceStateDatabaseHandle;
  identity: WorkspaceStateIdentity;
  attestedAtMs: number;
}): boolean {
  const snapshot = readWorkspaceStateSnapshotFromDatabase(params);
  if (
    snapshot.setupExists ||
    snapshot.attestation?.attestedAtMs !== params.attestedAtMs ||
    snapshot.attestation.generatedHashes.size > 0
  ) {
    return false;
  }
  executeSqliteQuerySync(
    params.database.db,
    getNodeSqliteKysely<WorkspaceStateDatabase>(params.database.db)
      .updateTable("workspace_setup_state")
      .set({ attested_at_ms: null, attestation_updated_at_ms: null })
      .where("workspace_key", "=", params.identity.workspaceKey),
  );
  return true;
}

/** Clear expired state only when no concurrent writer refreshed the vanished workspace. */
export async function clearExpiredWorkspaceStateForVanishedWorkspace(
  workspaceDir: string,
  nowMs = Date.now(),
  options: WorkspaceStateOperationOptions = {},
): Promise<boolean> {
  assertCanonicalIntegerTimestamp(nowMs, "workspace expiry check");
  return runOpenClawStateWriteTransaction((database) => {
    options.assertCurrent?.();
    const resolution = resolveWorkspaceIdentityFromDatabase({ workspaceDir, database });
    const identity = resolution.identity;
    const snapshot = readWorkspaceStateSnapshotFromDatabase({ identity, database });
    const preserveRecentState = () => {
      registerWorkspaceStateAliasIdentitiesInTransaction({
        database,
        identity,
        aliases: resolution.aliases,
        updatedAtMs: nowMs,
      });
      return false;
    };
    if (snapshot.attestation) {
      const ageMs = nowMs - snapshot.attestation.attestedAtMs;
      if (ageMs <= WORKSPACE_ATTESTATION_RECENT_MS) {
        return preserveRecentState();
      }
    }
    if (
      (snapshot.setup.bootstrapSeededAt || snapshot.setup.setupCompletedAt) &&
      snapshot.setupUpdatedAtMs !== undefined
    ) {
      const ageMs = nowMs - snapshot.setupUpdatedAtMs;
      if (ageMs <= WORKSPACE_ATTESTATION_RECENT_MS) {
        return preserveRecentState();
      }
    }
    deleteWorkspaceRows(database, identity);
    return true;
  });
}

/** Capture workspace identity before the filesystem entry is removed. */
export function prepareWorkspaceStateDeletion(workspaceDir: string): WorkspaceStateDeletionPlan {
  const aliases = resolveWorkspaceStateAliases(workspaceDir);
  return {
    cacheRoot: resolveCanonicalWorkspacePath(workspaceDir),
    lexicalAlias: aliases[0]!,
    currentCanonicalIdentity: aliases.at(-1)!,
    pathEntryExisted: workspacePathEntryExists(workspaceDir),
  };
}

export async function deleteWorkspaceState(
  plan: WorkspaceStateDeletionPlan,
  options: WorkspaceStateOperationOptions = {},
): Promise<void> {
  // Delete-only cleanup must not recreate state after reset/uninstall removed
  // the canonical database successfully or partially.
  if (!existsSync(resolveOpenClawStateSqlitePath())) {
    options.assertCurrent?.();
    retireWorkspaceFileCache(plan.cacheRoot);
    return;
  }
  runOpenClawStateWriteTransaction((database) => {
    options.assertCurrent?.();
    const { lexicalAlias, currentCanonicalIdentity } = plan;
    const kysely = getNodeSqliteKysely<WorkspaceStateDatabase>(database.db);
    const storedAlias = executeSqliteQueryTakeFirstSync(
      database.db,
      kysely
        .selectFrom("workspace_path_aliases")
        .selectAll()
        .where("alias_key", "=", lexicalAlias.workspaceKey),
    );
    if (storedAlias && storedAlias.alias_path !== lexicalAlias.workspacePath) {
      throw new Error("workspace path alias key collision");
    }
    const storedIdentity = storedAlias
      ? createWorkspaceStateIdentity(storedAlias.workspace_path)
      : undefined;
    if (storedIdentity && storedIdentity.workspaceKey !== storedAlias?.workspace_key) {
      throw new Error("workspace path alias target is invalid");
    }
    if (
      storedIdentity &&
      plan.pathEntryExisted &&
      storedIdentity.workspaceKey !== currentCanonicalIdentity.workspaceKey
    ) {
      // A repointed configured alias no longer owns its former canonical
      // workspace. Remove only that stale association, then clean current state.
      executeSqliteQuerySync(
        database.db,
        kysely
          .deleteFrom("workspace_path_aliases")
          .where("alias_key", "=", lexicalAlias.workspaceKey),
      );
      const currentResolution = resolveWorkspaceIdentityFromDatabase({
        workspaceDir: currentCanonicalIdentity.workspacePath,
        database,
      });
      return deleteWorkspaceRows(database, currentResolution.identity);
    }
    if (storedIdentity) {
      return deleteWorkspaceRows(database, storedIdentity);
    }
    const resolution = resolveWorkspaceIdentityFromDatabase({
      workspaceDir: currentCanonicalIdentity.workspacePath,
      database,
    });
    return deleteWorkspaceRows(database, resolution.identity);
  });
}
