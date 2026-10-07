import { existsSync } from "node:fs";
import path from "node:path";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { resolveUserPath } from "../utils.js";
import { retireWorkspaceFileCache } from "./workspace-file-cache.js";
import { captureWorkspaceStateFilesystemGuard } from "./workspace-state-guard.js";
import {
  createWorkspaceStateIdentity,
  resolveCanonicalWorkspacePath,
  resolveWorkspaceStateAliases,
  resolveWorkspaceStateIdentity,
  type WorkspaceStateIdentity,
} from "./workspace-state-identity.js";
import {
  assertCanonicalIntegerTimestamp,
  assertCanonicalTimestamp,
  readWorkspaceStateSnapshotFromDatabase,
  deleteWorkspaceStateRowsInDatabase,
  resolveWorkspaceIdentityFromDatabase,
  WORKSPACE_SETUP_STATE_VERSION,
  workspacePathEntryExists,
  type WorkspaceAttestation,
  type WorkspaceAttestationInput,
  type WorkspaceSetupState,
  type WorkspaceStateDatabase,
  type WorkspaceStateDatabaseHandle,
  type WorkspaceStateSnapshot,
} from "./workspace-state-store.kernel.js";
import type {
  WorkspaceStateGuard,
  WorkspaceStateWorkerOperations,
} from "./workspace-state-store.worker-contract.js";

export {
  hasRecentWorkspaceSetupState,
  hasWorkspaceSetupStateMarker,
  recentWorkspaceAttestation,
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

type WorkspaceStateOperationOptions = { assertCurrent?: () => void } & Pick<
  WorkspaceStateGuard,
  "recoveryHoldPredicate" | "beforeLegacyApply"
>;

type WorkspaceStateDeletionPlan = {
  cacheRoot: string;
  lexicalAlias: WorkspaceStateIdentity;
  currentCanonicalIdentity: WorkspaceStateIdentity;
  pathEntryExisted: boolean;
};

async function runWorkspaceStateOperation<K extends keyof WorkspaceStateWorkerOperations>(
  command: { type: K; input: WorkspaceStateWorkerOperations[K]["input"] },
  options: OpenClawStateDatabaseOptions & WorkspaceStateOperationOptions,
): Promise<WorkspaceStateWorkerOperations[K]["output"]> {
  const capturedCommand = {
    ...command,
    input: {
      ...command.input,
      recoveryHoldPredicate: structuredClone(options.recoveryHoldPredicate),
    },
  };
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  const assertFilesystem = captureWorkspaceStateFilesystemGuard(
    command.input.workspaceDir,
    command.type !== "workspace.snapshotAndRegister",
  );
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.assertCurrent?.();
    assertFilesystem();
  };
  let expiryResult: string | false | undefined;
  let publication: Promise<void> | undefined;
  try {
    const result = await runOpenClawStateWorkerOperation(
      context,
      async (scope) => {
        try {
          options.beforeLegacyApply?.();
          return await scope.execute(capturedCommand);
        } finally {
          // Native settlement and cache retirement stay inside the writer's FIFO interval.
          await publication;
        }
      },
      {
        assertCurrent,
        createAdmission: (operation) => {
          const admission = createSqliteWorkerOperationAdmission((request, grant) => {
            if (request.stage !== "transaction" && request.stage !== "commit") {
              throw new Error("Workspace state requires transaction admission");
            }
            assertCurrent();
            if (command.type === "workspace.expire" && request.stage === "commit") {
              if (typeof request.facts !== "string" && request.facts !== false) {
                throw new Error("Workspace expiry has no admitted result");
              }
              expiryResult = request.facts;
            }
            grant();
          });
          const accepted = admission;
          publication = operation.settled.then(() => {
            if (typeof expiryResult === "string" && accepted.committed?.facts === expiryResult) {
              retireWorkspaceFileCache(expiryResult);
            }
          });
          return { admission, nativeLocations: [context.admission.databasePath] };
        },
      },
    );
    assertCurrent();
    return result;
  } finally {
    await publication;
  }
}

export async function readWorkspaceStateSnapshot(
  workspaceDir: string,
  options: OpenClawStateDatabaseOptions & WorkspaceStateOperationOptions = {},
): Promise<WorkspaceStateSnapshot> {
  const capturedWorkspaceDir = path.resolve(resolveUserPath(workspaceDir));
  if (options.readOnly) {
    const assertFilesystem = captureWorkspaceStateFilesystemGuard(capturedWorkspaceDir, false);
    const reply = await executeExistingOpenClawStateRead(options, {
      type: "workspace.snapshot",
      workspaceDir: capturedWorkspaceDir,
    });
    options.assertCurrent?.();
    assertFilesystem();
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
  return runWorkspaceStateOperation(
    { type: "workspace.snapshotAndRegister", input: { workspaceDir: capturedWorkspaceDir } },
    options,
  );
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
  return runWorkspaceStateOperation(
    {
      type: "workspace.mergeSetup",
      input: {
        workspaceDir: path.resolve(resolveUserPath(workspaceDir)),
        next: { ...next },
        nowMs,
      },
    },
    options,
  );
}

export async function replaceWorkspaceAttestation(
  params: WorkspaceAttestationInput & WorkspaceStateOperationOptions,
): Promise<WorkspaceAttestation> {
  const context = captureOpenClawStateWorkerContext();
  const { assertCurrent } = params;
  const input = {
    workspaceDir: path.resolve(resolveUserPath(params.workspaceDir)),
    attestedAtMs: params.attestedAtMs,
    generatedHashes: new Map(params.generatedHashes),
    nowMs: params.nowMs,
    recoveryHoldPredicate: structuredClone(params.recoveryHoldPredicate),
  };
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => {
      params.beforeLegacyApply?.();
      return scope.execute({ type: "workspace.replaceAttestation", input });
    },
    {
      assertCurrent,
      createAdmission: () => ({
        nativeLocations: [context.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage !== "transaction" && request.stage !== "commit") {
            throw new Error("Workspace attestation requires transaction admission");
          }
          context.admission.assertCurrent();
          assertCurrent?.();
          grant();
        }),
      }),
    },
  );
}

function deleteWorkspaceRows(
  database: WorkspaceStateDatabaseHandle,
  identity: WorkspaceStateIdentity,
): void {
  deleteWorkspaceStateRowsInDatabase(database, identity);
  // Explicit agent deletion retains its native transaction and publication owner.
  deferSqlitePostCommitPublication(database.db, () =>
    retireWorkspaceFileCache(identity.workspacePath),
  );
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
  const result = await runWorkspaceStateOperation(
    {
      type: "workspace.expire",
      input: {
        workspaceDir: path.resolve(resolveUserPath(workspaceDir)),
        nowMs,
      },
    },
    options,
  );
  return result !== false;
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
    let storedIdentity = storedAlias
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
      storedIdentity = undefined;
    }
    return deleteWorkspaceRows(
      database,
      storedIdentity ??
        resolveWorkspaceIdentityFromDatabase({
          workspaceDir: currentCanonicalIdentity.workspacePath,
          database,
        }).identity,
    );
  });
}
