import fs from "node:fs/promises";
import path from "node:path";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { AgentDeletionWorkerAuthority } from "../state/agent-deletion-worker.types.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  captureOpenClawStateReadWorkerContext,
  captureOpenClawStateWorkerContext,
} from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { resolveUserPath } from "../utils.js";
import { assertNoUnmigratedWorkspaceState } from "./workspace-legacy-state.js";
import { readCachedWorkspaceStateSnapshot } from "./workspace-state-cache.js";
import {
  captureWorkspaceFilesystemEvidence,
  installWorkspaceFilesystemEvidence,
  prepareWorkspaceStateRead,
  validateWorkspaceFilesystemEvidence,
  type WorkspaceFilesystemEvidence,
} from "./workspace-state-guard.js";
import {
  createWorkspaceStateAliases,
  resolveCanonicalWorkspacePathAsync,
} from "./workspace-state-identity.js";
import {
  withWorkspaceStatePublication,
  workspaceStatePublication,
  readWorkspaceStateReceipt,
} from "./workspace-state-publication.js";
import type { WorkspaceAttestationInput } from "./workspace-state-store.kernel.js";
import type {
  WorkspaceStateDeletionPlan,
  WorkspaceStateGuard,
  WorkspaceStateWorkerOperations,
} from "./workspace-state-store.worker-contract.js";
import {
  WORKSPACE_SETUP_STATE_VERSION,
  type WorkspaceAttestation,
  type WorkspaceSetupState,
  type WorkspaceStateSnapshot,
} from "./workspace-state-types.js";

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
} from "./workspace-state-store.kernel.js";
export {
  WORKSPACE_SETUP_STATE_VERSION,
  type WorkspaceAttestation,
  type WorkspaceSetupState,
  type WorkspaceStateSnapshot,
} from "./workspace-state-types.js";

type WorkspaceStateOperationOptions = {
  assertCurrent?: () => void;
} & Pick<
  WorkspaceStateGuard,
  "recoveryHoldPredicate" | "beforeLegacyApply" | "filesystem" | "stateOwnerPath"
>;

async function runWorkspaceStateOperation<
  K extends Exclude<keyof WorkspaceStateWorkerOperations, "workspace.delete">,
>(
  command: { type: K; input: WorkspaceStateWorkerOperations[K]["input"] },
  options: OpenClawStateDatabaseOptions & WorkspaceStateOperationOptions,
  filesystem?: Awaited<ReturnType<typeof prepareWorkspaceStateRead>>,
): Promise<WorkspaceStateWorkerOperations[K]["output"]> {
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.assertCurrent?.();
  };
  const evidence =
    filesystem?.evidence ??
    (await captureWorkspaceFilesystemEvidence(
      command.input.workspaceDir,
      command.type !== "workspace.snapshotAndRegister" &&
        command.type !== "workspace.replaceAttestation",
    ));
  assertCurrent();
  const capturedCommand = {
    ...command,
    input: {
      ...command.input,
      recoveryHoldPredicate: options.recoveryHoldPredicate,
      filesystem: [...(options.filesystem ?? []), evidence],
      stateOwnerPath: options.stateOwnerPath,
    },
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
          // SAFETY: These are the paired workspace worker's observations for this command.
          const facts = request.facts as {
            filesystem: readonly Pick<WorkspaceFilesystemEvidence, "root">[];
          };
          installWorkspaceFilesystemEvidence(capturedCommand.input.filesystem, facts.filesystem);
          grant();
        });
        return { admission, nativeLocations: [context.admission.databasePath] };
      }),
    },
  );
  assertCurrent();
  return result;
}

export async function readWorkspaceStateSnapshot(
  workspaceDir: string,
  options: OpenClawStateDatabaseOptions &
    WorkspaceStateOperationOptions & { checkLegacySources?: boolean } = {},
): Promise<WorkspaceStateSnapshot> {
  const capturedWorkspaceDir = path.resolve(resolveUserPath(workspaceDir));
  const context = (
    options.readOnly ? captureOpenClawStateReadWorkerContext : captureOpenClawStateWorkerContext
  )({
    ...options,
    path: options.database?.path ?? options.path,
  });
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.assertCurrent?.();
  };
  const filesystem = await prepareWorkspaceStateRead(capturedWorkspaceDir);
  assertCurrent();
  const validateFilesystem = async () => {
    for (const evidence of [filesystem.evidence, ...(options.filesystem ?? [])]) {
      await validateWorkspaceFilesystemEvidence(evidence);
      assertCurrent();
    }
  };
  if (options.checkLegacySources) {
    await assertNoUnmigratedWorkspaceState({
      workspaceDir: capturedWorkspaceDir,
      canonicalPath: filesystem.canonicalPath,
    });
  }
  assertCurrent();
  if (options.readOnly) {
    const reply = await executeExistingOpenClawStateRead(
      options,
      {
        type: "workspace.snapshot",
        workspaceDir: capturedWorkspaceDir,
      },
      { context },
    );
    await validateFilesystem();
    assertCurrent();
    return (
      reply?.snapshot ?? {
        identity: filesystem.aliases.at(-1)!,
        setupExists: false,
        setup: { version: WORKSPACE_SETUP_STATE_VERSION },
      }
    );
  }
  const read = () =>
    runWorkspaceStateOperation(
      { type: "workspace.snapshotAndRegister", input: { workspaceDir: capturedWorkspaceDir } },
      options,
      filesystem,
    );
  // Recovery predicates require the worker's current journal check. Ordinary
  // preparation reuses state until its owning writer publishes a change.
  const snapshot =
    options.recoveryHoldPredicate || options.beforeLegacyApply
      ? await read()
      : await readCachedWorkspaceStateSnapshot(context, JSON.stringify(filesystem.aliases), read);
  await validateFilesystem();
  assertCurrent();
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

export async function rollbackWorkspaceBootstrapSeed(
  workspaceDir: string,
  bootstrapSeededAt: string,
  options: OpenClawStateDatabaseOptions & WorkspaceStateOperationOptions = {},
): Promise<void> {
  return runWorkspaceStateOperation(
    {
      type: "workspace.rollbackBootstrapSeed",
      input: { workspaceDir: path.resolve(resolveUserPath(workspaceDir)), bootstrapSeededAt },
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
export async function prepareWorkspaceStateDeletion(
  workspaceDir: string,
): Promise<WorkspaceStateDeletionPlan> {
  const canonicalRoot = await resolveCanonicalWorkspacePathAsync(workspaceDir);
  const aliases = createWorkspaceStateAliases(workspaceDir, canonicalRoot);
  return {
    lexicalAlias: aliases[0]!,
    currentCanonicalIdentity: aliases.at(-1)!,
    pathEntryExisted: await fs.lstat(path.resolve(resolveUserPath(workspaceDir))).then(
      () => true,
      () => false,
    ),
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
  await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "workspace.delete", input: { plan } }),
    {
      existingOnly: true,
      assertCurrent,
      createAdmission: withWorkspaceStatePublication(context, () => {
        const admission = createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage !== "transaction" && request.stage !== "commit") {
            throw new Error("Workspace deletion requires transaction admission");
          }
          assertCurrent();
          grant();
        });
        return { admission, nativeLocations: [context.admission.databasePath] };
      }),
    },
  );
  assertCurrent();
}
