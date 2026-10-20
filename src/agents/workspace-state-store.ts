import { existsSync } from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createSqliteWorkerOperationAdmission,
  observeSqliteWorkerCommittedFacts,
} from "../infra/sqlite-worker-operation-admission.js";
import type { AgentDeletionWorkerAuthority } from "../state/agent-deletion-worker.types.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { resolveUserPath } from "../utils.js";
import { retireWorkspaceFileCache } from "./workspace-file-cache.js";
import { readCachedWorkspaceStateSnapshot } from "./workspace-state-cache.js";
import { captureWorkspaceStateFilesystemGuard } from "./workspace-state-guard.js";
import {
  resolveCanonicalWorkspacePath,
  resolveWorkspaceStateAliases,
  resolveWorkspaceStateIdentity,
} from "./workspace-state-identity.js";
import {
  withWorkspaceStatePublication,
  workspaceStatePublication,
  readWorkspaceStateReceipt,
} from "./workspace-state-publication.js";
import {
  WORKSPACE_SETUP_STATE_VERSION,
  workspacePathEntryExists,
  type WorkspaceAttestation,
  type WorkspaceAttestationInput,
  type WorkspaceSetupState,
  type WorkspaceStateSnapshot,
} from "./workspace-state-store.kernel.js";
import type {
  WorkspaceStateDeletionPlan,
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

async function runWorkspaceStateOperation<
  K extends Exclude<keyof WorkspaceStateWorkerOperations, "workspace.delete">,
>(
  command: { type: K; input: WorkspaceStateWorkerOperations[K]["input"] },
  options: OpenClawStateDatabaseOptions & WorkspaceStateOperationOptions,
): Promise<WorkspaceStateWorkerOperations[K]["output"]> {
  const capturedCommand = {
    ...command,
    input: {
      ...command.input,
      recoveryHoldPredicate: options.recoveryHoldPredicate,
    },
  };
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  const assertFilesystem =
    command.type === "workspace.replaceAttestation"
      ? undefined
      : captureWorkspaceStateFilesystemGuard(
          command.input.workspaceDir,
          command.type !== "workspace.snapshotAndRegister",
        );
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.assertCurrent?.();
    assertFilesystem?.();
  };
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) => {
      options.beforeLegacyApply?.();
      return scope.execute(capturedCommand);
    },
    {
      assertCurrent,
      createAdmission: withWorkspaceStatePublication(context, () => {
        const admission = createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage !== "transaction" && request.stage !== "commit") {
            throw new Error("Workspace state requires transaction admission");
          }
          assertCurrent();
          grant();
        });
        if (command.type === "workspace.expire") {
          // Retire at native COMMIT, inside the existing writer's FIFO interval.
          observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
            const expiredRoot = readWorkspaceStateReceipt(facts).result;
            if (typeof expiredRoot === "string") {
              retireWorkspaceFileCache(expiredRoot);
            }
          });
        }
        return { admission, nativeLocations: [context.admission.databasePath] };
      }),
    },
  );
  assertCurrent();
  return result;
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
    return (
      reply?.snapshot ?? {
        identity: resolveWorkspaceStateIdentity(capturedWorkspaceDir),
        setupExists: false,
        setup: { version: WORKSPACE_SETUP_STATE_VERSION },
      }
    );
  }
  const read = () =>
    runWorkspaceStateOperation(
      { type: "workspace.snapshotAndRegister", input: { workspaceDir: capturedWorkspaceDir } },
      options,
    );
  // Recovery predicates require the worker's current journal check. Ordinary
  // preparation reuses state until its owning writer publishes a change.
  if (options.recoveryHoldPredicate || options.beforeLegacyApply) {
    return read();
  }
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  const assertFilesystem = captureWorkspaceStateFilesystemGuard(capturedWorkspaceDir, false);
  const snapshot = await readCachedWorkspaceStateSnapshot(
    context,
    JSON.stringify(resolveWorkspaceStateAliases(capturedWorkspaceDir)),
    read,
  );
  options.assertCurrent?.();
  assertFilesystem();
  return snapshot;
}

export async function mergeWorkspaceSetupState(
  workspaceDir: string,
  next: Partial<Omit<WorkspaceSetupState, "version">>,
  nowMs = Date.now(),
  options: OpenClawStateDatabaseOptions & WorkspaceStateOperationOptions = {},
): Promise<WorkspaceSetupState> {
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
  return runWorkspaceStateOperation(
    {
      type: "workspace.replaceAttestation",
      input: {
        workspaceDir: path.resolve(resolveUserPath(params.workspaceDir)),
        attestedAtMs: params.attestedAtMs,
        generatedHashes: new Map(params.generatedHashes),
        nowMs: params.nowMs,
      },
    },
    params,
  );
}

/** Clear expired state only when no concurrent writer refreshed the vanished workspace. */
export async function clearExpiredWorkspaceStateForVanishedWorkspace(
  workspaceDir: string,
  nowMs = Date.now(),
  options: WorkspaceStateOperationOptions = {},
): Promise<boolean> {
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
  options: Pick<OpenClawStateDatabaseOptions, "database" | "path" | "env"> & {
    /** Host-only authority; the deletion owner supplies durable transaction predicates. */
    assertCurrent?: () => void;
    deletion?: AgentDeletionWorkerAuthority;
  } = {},
): Promise<void> {
  const publish = (facts: ReturnType<typeof readWorkspaceStateReceipt>) => {
    const result = facts.result;
    if (
      !isRecord(result) ||
      result.kind !== "workspace-deleted" ||
      typeof result.workspacePath !== "string"
    ) {
      throw new Error("Workspace deletion has no committed result");
    }
    retireWorkspaceFileCache(result.workspacePath);
  };
  const deletionOwner = options.deletion;
  if (deletionOwner) {
    let publication: ReturnType<typeof workspaceStatePublication.begin> | undefined;
    try {
      await deletionOwner.runWithWorker(
        (scope, deletion) => scope.execute({ type: "workspace.delete", input: { plan, deletion } }),
        {
          onAdmission: (_request, identity) => {
            publication ??= workspaceStatePublication.begin({
              identity,
              assertCurrent: deletionOwner.assertCurrentHost,
            });
          },
          onCommitted: (facts) => {
            const receipt = readWorkspaceStateReceipt(facts);
            publication?.committed(receipt.receipt);
            publish(receipt);
          },
        },
      );
      publication?.finish(true);
    } finally {
      publication?.finish(false);
    }
    deletionOwner.assertCurrentHost();
    return;
  }
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  const assertHost = options.assertCurrent;
  const assertCurrent = () => {
    context.admission.assertCurrent();
    assertHost?.();
  };
  assertCurrent();
  // Delete-only cleanup must not recreate state after reset/uninstall removed
  // the canonical database successfully or partially.
  if (!existsSync(context.admission.databasePath)) {
    retireWorkspaceFileCache(plan.cacheRoot);
    return;
  }
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "workspace.delete", input: { plan } }),
    {
      existingOnly: true,
      assertCurrent,
      createAdmission: withWorkspaceStatePublication(
        context,
        () => {
          const admission = createSqliteWorkerOperationAdmission((request, grant) => {
            if (request.stage !== "transaction" && request.stage !== "commit") {
              throw new Error("Workspace deletion requires transaction admission");
            }
            assertCurrent();
            grant();
          });
          return { admission, nativeLocations: [context.admission.databasePath] };
        },
        publish,
      ),
    },
  );
  assertCurrent();
  if (result === undefined) {
    retireWorkspaceFileCache(plan.cacheRoot);
  }
}
