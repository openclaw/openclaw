import { existsSync } from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
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
  workspaceStateReceiptResult,
} from "./workspace-state-publication.js";
import {
  assertCanonicalIntegerTimestamp,
  assertCanonicalTimestamp,
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
        createAdmission: withWorkspaceStatePublication(context, (operation) => {
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
            if (
              typeof expiryResult === "string" &&
              accepted.committed &&
              workspaceStateReceiptResult(accepted.committed.facts) === expiryResult
            ) {
              retireWorkspaceFileCache(expiryResult);
            }
          });
          return { admission, nativeLocations: [context.admission.databasePath] };
        }),
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
      createAdmission: withWorkspaceStatePublication(context, () => ({
        nativeLocations: [context.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage !== "transaction" && request.stage !== "commit") {
            throw new Error("Workspace attestation requires transaction admission");
          }
          context.admission.assertCurrent();
          assertCurrent?.();
          grant();
        }),
      })),
    },
  );
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
  options: Pick<OpenClawStateDatabaseOptions, "database" | "path" | "env"> & {
    /** Host-only authority; the deletion owner supplies durable transaction predicates. */
    assertCurrent?: () => void;
    deletion?: AgentDeletionWorkerAuthority;
  } = {},
): Promise<void> {
  const capturedPlan = structuredClone(plan);
  const publish = (facts: unknown) => {
    const result = workspaceStateReceiptResult(facts);
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
        (scope, deletion) =>
          scope.execute({ type: "workspace.delete", input: { plan: capturedPlan, deletion } }),
        {
          onAdmission: (_request, identity) => {
            publication ??= workspaceStatePublication.begin({
              identity,
              assertCurrent: deletionOwner.assertCurrentHost,
            });
          },
          onCommitted: (facts) => {
            if (isRecord(facts)) {
              publication?.committed(facts.receipt);
            }
            publish(facts);
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
    retireWorkspaceFileCache(capturedPlan.cacheRoot);
    return;
  }
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "workspace.delete", input: { plan: capturedPlan } }),
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
    retireWorkspaceFileCache(capturedPlan.cacheRoot);
  }
}
