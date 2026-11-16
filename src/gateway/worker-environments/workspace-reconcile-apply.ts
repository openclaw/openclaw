import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  captureWorkspaceFilesystemEvidence,
  createWorkspaceFilesystemSource,
} from "../../agents/workspace-state-guard.js";
import type { WorktreeWorkerAuthority } from "../../agents/worktrees/types.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { hasErrnoCode } from "../../infra/errno.js";
import {
  stagedInputDirectoriesFromEntries,
  stagedInputPathDirectory,
} from "../../media/staged-inputs.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";
import { withWorkspaceHashContext } from "./workspace-hash-memo.js";
import {
  MAX_WORKSPACE_RESULT_CHANGED_PATHS,
  WorkspaceResultLimitError,
} from "./workspace-inventory-limits.js";
import type { WorkspaceReconciliationPreparation } from "./workspace-manifest-comparison.js";
import type { WorkspaceReconciliationOperations } from "./workspace-manifest-computation.js";
import {
  captureWorkspaceManifest,
  prepareWorkspacePatch,
  prepareWorkspaceTemporaryDirectory,
  runWorkspaceFilesystemComputation,
} from "./workspace-manifest-worker.js";
import type {
  WorkerWorkspaceManifest,
  WorkerWorkspaceManifestEntry,
  WorkerWorkspaceReconciliationJournal,
  WorkerWorkspaceReconciliationJournalAdapter,
} from "./workspace-manifest.js";
import {
  createWorkspaceManifestVerifier,
  preflightWorkspaceApply,
  prepareWorkspaceDirectoryChanges,
  retainedConflictPaths,
  type WorkerWorkspaceApplyResult,
} from "./workspace-reconcile-core.js";
import { reconciliationDirectories } from "./workspace-reconcile-derived-paths.js";
import { recoverWorkerWorkspaceReconciliation } from "./workspace-reconcile-recovery.js";

export async function applyStagedWorkerWorkspace(params: {
  root: string;
  stagingRoot: string;
  baseManifestRef: string;
  currentManifestRef: string;
  reconciliation: WorkspaceReconciliationPreparation;
  current: WorkerWorkspaceManifest;
  additionalPaths?: ReadonlySet<string>;
  journal: WorkerWorkspaceReconciliationJournalAdapter;
  assertCurrent?: () => void;
  workerAuthority?: WorktreeWorkerAuthority;
  /** Holds every target writer through acceptance or rollback. */
  freezeTarget?: () => Promise<void>;
  onPhase?: (phase: "preflight" | "patch" | "capture" | "verification" | "apply") => void;
  acceptance:
    | {
        kind: "reconcile";
        publish?: (accepted: {
          manifestRef: string;
          manifest: WorkerWorkspaceManifest;
          conflictPaths: string[];
        }) => Promise<void>;
      }
    | { kind: "exact-target"; verify: () => Promise<void> };
}): Promise<WorkerWorkspaceApplyResult> {
  return await withWorkspaceHashContext(async (): Promise<WorkerWorkspaceApplyResult> => {
    const target =
      params.workerAuthority?.workspaceEvidence?.find(
        (evidence) => evidence.workspaceDir === params.root,
      ) ?? (await captureWorkspaceFilesystemEvidence(params.root));
    const root = target.canonical;
    const filesystemAuthority = {
      workerAuthority: params.workerAuthority,
      assertCurrent: composeSessionSourceAssertion([
        params.assertCurrent,
        createWorkspaceFilesystemSource(target, () => {}),
      ]),
    };
    const { preflight: preflightInput, includePaths: preparedPaths } = params.reconciliation;
    if (preflightInput.changedPaths.length > MAX_WORKSPACE_RESULT_CHANGED_PATHS) {
      throw new WorkspaceResultLimitError(
        `Workspace result changes ${preflightInput.changedPaths.length} files/directories (limit ${MAX_WORKSPACE_RESULT_CHANGED_PATHS}).`,
      );
    }
    const baseNodes = new Map(preflightInput.baseNodes);
    const currentNodes = new Map(preflightInput.currentNodes);
    const changed = new Set(preflightInput.changedPaths);
    const buildCacheInputs =
      preflightInput.buildCacheInputs === undefined
        ? undefined
        : new Set(preflightInput.buildCacheInputs);
    const stagedInputDirectories = stagedInputDirectoriesFromEntries(params.current.entries);
    const acceptance = params.acceptance;
    const acceptExactTarget = async (
      verify: () => Promise<void>,
    ): Promise<WorkerWorkspaceApplyResult> => {
      await verify();
      params.assertCurrent?.();
      await params.journal.commit(params.currentManifestRef);
      return {
        manifest: params.current,
        manifestRef: params.currentManifestRef,
        conflictPaths: [],
        verifyLocalStable: verify,
      };
    };
    const candidates: WorkspaceReconciliationOperations["workspace.reconcile.ownership"]["input"]["candidates"] =
      [];
    if (stagedInputDirectories.size > 0) {
      for (const entryPath of currentNodes.keys()) {
        const directory = stagedInputPathDirectory(entryPath);
        if (directory && stagedInputDirectories.has(directory)) {
          candidates.push({
            path: entryPath,
            directory,
            changesMarker: entryPath === `${directory}/.gitignore` && changed.has(entryPath),
            isNew: !baseNodes.has(entryPath),
          });
        }
      }
    }
    const assertInputOwnership = async () => {
      if (stagedInputDirectories.size === 0) {
        return;
      }
      await runWorkspaceFilesystemComputation(
        {
          type: "workspace.reconcile.ownership",
          input: { root: params.root, stagedInputDirectories, candidates },
        },
        filesystemAuthority,
      );
    };
    await assertInputOwnership();
    const preserveDirectories = new Set(
      reconciliationDirectories(
        params.current.directories,
        stagedInputDirectories,
        buildCacheInputs && [...buildCacheInputs],
      ),
    );
    // Git workspaces must keep the eligibility boundary established at dispatch.
    // Local-only ignored files are outside both manifests and must never enter the accepted state.
    const includePaths =
      preparedPaths && params.additionalPaths?.size
        ? new Set([...preparedPaths, ...params.additionalPaths])
        : preparedPaths;
    const inspectPaths = () => {
      params.onPhase?.("preflight");
      return preflightWorkspaceApply({ root, ...preflightInput });
    };
    const preflight = await inspectPaths();
    const acceptReconciled = async (
      reconcile: Extract<typeof acceptance, { kind: "reconcile" }>,
      preparedPreflight?: Awaited<ReturnType<typeof inspectPaths>>,
    ) => {
      params.onPhase?.("capture");
      const actual = await captureWorkspaceManifest({
        root,
        baseCommit: params.current.baseCommit,
        preserveDirectories,
        includePaths,
        buildCacheInputs,
      });
      const finalPreflight = preparedPreflight ?? (await inspectPaths());
      const verifyLocalStable = createWorkspaceManifestVerifier({
        root,
        expectedRef: actual.manifestRef,
        baseCommit: actual.manifest.baseCommit,
        preserveDirectories,
        includePaths,
        buildCacheInputs,
      });
      // A frozen target cannot change between capture and acceptance. Unfenced
      // host callers still verify, and the returned verifier protects later use.
      if (!params.freezeTarget) {
        params.onPhase?.("verification");
        await verifyLocalStable();
      }
      const conflictPaths = retainedConflictPaths(finalPreflight, preflight.applyPaths);
      params.assertCurrent?.();
      await reconcile.publish?.({ ...actual, conflictPaths });
      params.assertCurrent?.();
      await params.journal.commit(actual.manifestRef);
      return {
        ...actual,
        conflictPaths,
        verifyLocalStable,
      };
    };
    if (changed.size === 0) {
      await params.freezeTarget?.();
      return acceptance.kind === "exact-target"
        ? await acceptExactTarget(acceptance.verify)
        : await acceptReconciled(acceptance, preflight);
    }
    const baseEntries = [...baseNodes.values()].filter(
      (entry): entry is WorkerWorkspaceManifestEntry =>
        entry.type !== "directory" &&
        changed.has(entry.path) &&
        preflight.applyPaths.has(entry.path),
    );
    // Preflight selects paths still matching base and skips already-applied entries.
    // The confirming preflight below detects changes during patch preparation.
    const appliedEntries = [...currentNodes.values()].filter(
      (entry): entry is WorkerWorkspaceManifestEntry =>
        entry.type !== "directory" &&
        changed.has(entry.path) &&
        preflight.applyPaths.has(entry.path),
    );
    const baseDirectories = [...preflight.applyPaths]
      .filter((entryPath) => baseNodes.get(entryPath)?.type === "directory")
      .toSorted();
    const appliedDirectories = [...preflight.applyPaths]
      .filter((entryPath) => currentNodes.get(entryPath)?.type === "directory")
      .toSorted();
    params.onPhase?.("patch");
    const snapshot = await prepareWorkspacePatch({
      root,
      stagingRoot: params.stagingRoot,
      baseEntries,
      appliedEntries,
    });
    // Preparation may run beside guest writes; fence them before confirming the plan.
    await params.freezeTarget?.();
    const confirmedPreflight = await inspectPaths();
    if (!isDeepStrictEqual(confirmedPreflight, preflight)) {
      throw new Error("Gateway workspace changed while cloud reconciliation was being prepared");
    }
    // Revalidate before mutation, not after applying our own newly admitted paths.
    await assertInputOwnership();
    const journal: WorkerWorkspaceReconciliationJournal = {
      version: 1,
      temporaryNonce: randomBytes(16).toString("hex"),
      baseManifestRef: params.baseManifestRef,
      currentManifestRef: params.currentManifestRef,
      baseEntries,
      appliedEntries,
      baseDirectories,
      appliedDirectories,
      baseTree: snapshot.baseTree,
      basePackSha256: snapshot.basePackSha256,
      basePack: snapshot.basePack,
    };
    params.assertCurrent?.();
    await params.journal.begin(journal);
    try {
      params.onPhase?.("apply");
      const temporary = await prepareWorkspaceTemporaryDirectory("openclaw-workspace-apply-input-");
      try {
        const patchPath = path.join(temporary, "patch");
        await fs.writeFile(patchPath, snapshot.patch);
        await runWorkspaceFilesystemComputation(
          {
            type: "workspace.reconcile.apply",
            input: {
              root: params.root,
              directories: prepareWorkspaceDirectoryChanges({
                baseNodes,
                currentNodes,
                applyPaths: preflight.applyPaths,
              }),
              appliedEntries,
              buildCacheInputs,
              patchPath,
            },
          },
          filesystemAuthority,
        );
      } finally {
        await fs.rm(temporary, { recursive: true, force: true });
      }
      if (acceptance.kind === "exact-target") {
        await inspectPaths();
      } else {
        return await acceptReconciled(acceptance);
      }
    } catch (error) {
      // Transport or settlement timeouts are observation evidence, never authority
      // for an inverse operation; recovery owns restoring both sides.
      if (
        error instanceof AcceptedWorkspacePublicationIndeterminateError ||
        hasErrnoCode(error, "GATEWAY_STATE_OWNER_REQUIRED") ||
        hasErrnoCode(error, "WORKSPACE_ALIAS_REPOINTED")
      ) {
        throw error;
      }
      // A revoked owner cannot authorize an inverse mutation or consume the journal.
      params.assertCurrent?.();
      try {
        await recoverWorkerWorkspaceReconciliation({
          root: params.root,
          journal,
          buildCacheInputs: buildCacheInputs && [...buildCacheInputs],
          ...filesystemAuthority,
        });
        params.assertCurrent?.();
        await params.journal.abort();
      } catch (rollbackError) {
        const recoveryError = new Error("Cloud reconciliation failed and rollback needs recovery", {
          cause: error,
        });
        Object.defineProperty(recoveryError, "rollbackError", { value: rollbackError });
        throw recoveryError;
      }
      throw error;
    }
    // A late exact-target fence failure leaves the prepared owner's mutation pending.
    // It is not evidence permitting rollback or reopening that binding.
    return await acceptExactTarget(acceptance.verify);
  });
}
