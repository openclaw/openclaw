import fs from "node:fs/promises";
import path from "node:path";
import { runBestEffortCleanup } from "../../infra/non-fatal-cleanup.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runCommandWithTimeout, runExec } from "../../process/exec.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import type { WorkerLocalWorkspaceReconcileRequest } from "./tunnel-contract.js";
import { boundedWorkerError } from "./worker-error.js";
import {
  activeWorkspaceHashContext,
  withWorkspaceHashContext,
  withWorkspaceHashMemo,
} from "./workspace-hash-memo.js";
import { parseChangedWorkspaceResult } from "./workspace-manifest-comparison.js";
import {
  prepareWorkspaceStageInput,
  loadStagedWorkspaceManifest,
  readStagedWorkspaceManifestEntries,
} from "./workspace-manifest-worker.js";
import type {
  WorkerWorkspaceManifest,
  WorkerWorkspaceManifestEntry,
  WorkerWorkspaceReconciliationJournalAdapter,
} from "./workspace-manifest.js";
import { localPath } from "./workspace-reconcile-fs.js";
import {
  applyStagedWorkerWorkspace,
  assertWorkspaceMatchesManifest,
  inspectAcceptedWorkerWorkspace,
  type WorkerWorkspaceApplyResult,
} from "./workspace-reconcile.js";
import {
  requireWorkspaceResultGit as requireGit,
  updateWorkspaceResultRefs,
  withWorkspaceResultRefMutation,
  workspaceResultGitCommand as gitCommand,
  WORKSPACE_RESULT_GIT_TIMEOUT_MS as PATCH_TIMEOUT_MS,
} from "./workspace-result-git.js";
import {
  requireWorkerResultStorageRef,
  WORKER_RESULT_CANDIDATE_REF_PREFIX,
  WORKER_RESULT_CLEANUP_REF_PREFIX,
  WORKER_RESULT_REF_PREFIX,
} from "./workspace-result-inventory.js";

const WORKER_RESULT_CLAIM_ID_PATTERN = /^[A-Za-z0-9-]+$/u;
const workspaceLog = createSubsystemLogger("gateway/worker-workspace");

export function workerWorkspaceTransferPaths(
  current: WorkerWorkspaceManifest,
  base: WorkerWorkspaceManifest,
  signal?: AbortSignal,
): string[] {
  // Staging is directory-agnostic because it transfers file and symlink bytes only.
  signal?.throwIfAborted();
  return parseChangedWorkspaceResult(base, current).entries.map((entry) => entry.path);
}

function requireWorkerResultRef(ref: string): string {
  if (!ref.startsWith(`${WORKER_RESULT_REF_PREFIX}/`)) {
    throw new Error("Cloud workspace staged result reference is invalid");
  }
  return requireWorkerResultStorageRef(ref);
}

export function workerWorkspaceResultRef(claimId: string): string {
  if (!WORKER_RESULT_CLAIM_ID_PATTERN.test(claimId)) {
    throw new Error("Cloud workspace result claim id is invalid");
  }
  return `${WORKER_RESULT_REF_PREFIX}/${claimId}`;
}

export function preparedWorkerWorkspaceResultRef(stagedResultRef: string): string {
  const ref = requireWorkerResultRef(stagedResultRef);
  return `${WORKER_RESULT_CANDIDATE_REF_PREFIX}/${ref.slice(WORKER_RESULT_REF_PREFIX.length + 1)}`;
}

export function cleanupWorkerWorkspaceResultRef(stagedResultRef: string): string {
  const ref = requireWorkerResultRef(stagedResultRef);
  return `${WORKER_RESULT_CLEANUP_REF_PREFIX}/${ref.slice(WORKER_RESULT_REF_PREFIX.length + 1)}`;
}

export function isWorkerWorkspaceResultCleanupRef(ref: string): boolean {
  return ref.startsWith(`${WORKER_RESULT_CLEANUP_REF_PREFIX}/`);
}

async function hasGitAdminPath(root: string): Promise<boolean> {
  let current = root;
  while (true) {
    try {
      await fs.lstat(path.join(current, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

async function ensureWorkerWorkspaceResultRepository(
  root: string,
  assertCurrent?: () => void,
): Promise<string> {
  const resolved = await fs.realpath(root);
  const probe = await runCommandWithTimeout(gitCommand(resolved, ["rev-parse", "--git-dir"]), {
    timeoutMs: PATCH_TIMEOUT_MS,
    maxOutputBytes: 1024 * 1024,
  });
  if (probe.termination === "exit" && probe.code === 0) {
    return resolved;
  }
  assertCurrent?.();
  await requireGit(resolved, ["init", "--quiet", "--object-format=sha1"]);
  return resolved;
}

export async function hasWorkerWorkspaceResultRef(params: {
  root: string;
  stagedResultRef: string;
}): Promise<boolean> {
  let root: string;
  try {
    root = await fs.realpath(params.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (!(await hasGitAdminPath(root))) {
    const bare = await runCommandWithTimeout(
      gitCommand(root, ["rev-parse", "--is-bare-repository"]),
      {
        timeoutMs: PATCH_TIMEOUT_MS,
        maxOutputBytes: 1024,
      },
    );
    if (bare.termination !== "exit" || bare.code !== 0 || bare.stdout.trim() !== "true") {
      return false;
    }
  }
  const result = await runCommandWithTimeout(
    gitCommand(root, [
      "show-ref",
      "--verify",
      "--quiet",
      requireWorkerResultStorageRef(params.stagedResultRef),
    ]),
    { timeoutMs: PATCH_TIMEOUT_MS, maxOutputBytes: 1024 * 1024 },
  );
  if (result.termination === "exit" && result.code === 0) {
    return true;
  }
  if (result.termination === "exit" && result.code === 1) {
    return false;
  }
  throw new Error((result.stderr || result.stdout || "git show-ref failed").trim());
}

async function stageWorkerWorkspaceResult(params: {
  root: string;
  stagingRoot: string;
  stagedResultRef: string;
  baseManifestRef: string;
  currentManifestRef: string;
  baseManifestRaw: string;
  currentManifestRaw: string;
  assertCurrent?: () => void;
}): Promise<string> {
  const root = await ensureWorkerWorkspaceResultRepository(params.root, params.assertCurrent);
  const stagedResultRef = requireWorkerResultStorageRef(params.stagedResultRef);
  const temporary = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-workspace-import-"),
  );
  try {
    const inputPath = path.join(temporary, "fast-import");
    await prepareWorkspaceStageInput({ ...params, inputPath });
    const input = await fs.open(inputPath, "r");
    try {
      await withWorkspaceResultRefMutation(root, (baseEnv) => {
        params.assertCurrent?.();
        return runExec("git", gitCommand(root, ["fast-import", "--quiet"]).slice(1), {
          baseEnv,
          stdinFileDescriptor: input.fd,
          timeoutMs: PATCH_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        });
      });
    } finally {
      await input.close();
    }
    return await requireGit(root, ["rev-parse", `${stagedResultRef}^{commit}`]);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function materializeStagedEntry(params: {
  root: string;
  entry: WorkerWorkspaceManifestEntry;
  content?: Uint8Array;
}): Promise<void> {
  const target = localPath(params.root, params.entry.path);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if (params.entry.type === "symlink") {
    await fs.symlink(params.entry.target, target);
    return;
  }
  if (!params.content) {
    throw new Error(`Cloud workspace staged content is missing: ${params.entry.path}`);
  }
  await fs.writeFile(target, params.content, { mode: params.entry.mode, flag: "wx" });
  await fs.chmod(target, params.entry.mode);
}

export async function readStagedWorkerWorkspaceResult(root: string, stagedResultRef: string) {
  const { objectsByPath, ...snapshot } = await loadStagedWorkspaceManifest(root, stagedResultRef);
  const readEntries = () =>
    readStagedWorkspaceManifestEntries({ root, objectsByPath, entries: snapshot.changedEntries });
  return { ...snapshot, readEntries };
}

export async function withStagedWorkerWorkspaceResult<T>(
  params: { root: string; stagedResultRef: string },
  use: (
    snapshot: Awaited<ReturnType<typeof readStagedWorkerWorkspaceResult>> & { stagingRoot: string },
  ) => Promise<T>,
): Promise<T> {
  const snapshot = await readStagedWorkerWorkspaceResult(params.root, params.stagedResultRef);
  return await withMaterializedWorkerWorkspaceResult(snapshot, use);
}

async function withMaterializedWorkerWorkspaceResult<T>(
  snapshot: Awaited<ReturnType<typeof readStagedWorkerWorkspaceResult>>,
  use: (
    snapshot: Awaited<ReturnType<typeof readStagedWorkerWorkspaceResult>> & { stagingRoot: string },
  ) => Promise<T>,
): Promise<T> {
  const stagingRoot = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-checkpoint-payload-"),
  );
  try {
    let writes: Array<() => Promise<void>> = [];
    const flush = async () => {
      const result = await runTasksWithConcurrency({ tasks: writes, limit: 4, errorMode: "stop" });
      writes = [];
      if (result.hasError) {
        throw result.firstError;
      }
    };
    for await (const { entry, content } of snapshot.readEntries()) {
      writes.push(() => materializeStagedEntry({ root: stagingRoot, entry, content }));
      if (writes.length === 4) {
        await flush();
      }
    }
    await flush();
    await assertWorkspaceMatchesManifest({
      root: stagingRoot,
      manifest: snapshot.current,
      entries: snapshot.changedEntries,
    });
    return await use({ ...snapshot, stagingRoot });
  } finally {
    await runBestEffortCleanup({
      cleanup: () => fs.rm(stagingRoot, { recursive: true, force: true }),
      onError: (error) =>
        workspaceLog.warn(`worker workspace staging cleanup failed: ${boundedWorkerError(error)}`),
    });
  }
}

export async function applyStagedWorkerWorkspaceResult(params: {
  root: string;
  stagedResultRef: string;
  expectedBaseManifestRef: string;
  alreadyAccepted?: boolean;
  journal: WorkerWorkspaceReconciliationJournalAdapter;
  assertCurrent?: () => void;
  publishAcceptedManifest?: (accepted: {
    manifestRef: string;
    manifest: WorkerWorkspaceManifest;
    conflictPaths: string[];
  }) => Promise<void>;
}): Promise<WorkerWorkspaceApplyResult & { changed: boolean }> {
  return await withWorkspaceHashContext(
    async () => await applyStagedWorkerWorkspaceResultWithMemo(params),
  );
}

async function applyStagedWorkerWorkspaceResultWithMemo(
  params: Parameters<typeof applyStagedWorkerWorkspaceResult>[0],
): Promise<WorkerWorkspaceApplyResult & { changed: boolean }> {
  const root = await fs.realpath(params.root);
  const staged = await readStagedWorkerWorkspaceResult(root, params.stagedResultRef);
  if (params.alreadyAccepted || staged.baseManifestRef !== params.expectedBaseManifestRef) {
    // An acceptance marker proves the mutations already ran even when omitted
    // local nodes left the manifest ref unchanged. Re-snapshot; never replay.
    // A base advance proves the same commit-before-acceptance crash window.
    const accepted = await inspectAcceptedWorkerWorkspace({
      root,
      expectedManifestRef: params.expectedBaseManifestRef,
      allowAdvancedLocalState: true,
      base: staged.base,
      current: staged.current,
    });
    if (!accepted) {
      throw new Error("Cloud workspace staged result does not match the placement base");
    }
    params.assertCurrent?.();
    params.journal.commit(accepted.manifestRef);
    return {
      ...accepted,
      changed: staged.changed,
    };
  }
  return await withMaterializedWorkerWorkspaceResult(staged, async ({ stagingRoot }) => {
    const applied = await applyStagedWorkerWorkspace({
      root,
      stagingRoot,
      baseManifestRef: staged.baseManifestRef,
      currentManifestRef: staged.currentManifestRef,
      base: staged.base,
      current: staged.current,
      journal: params.journal,
      assertCurrent: params.assertCurrent,
      acceptance: { kind: "reconcile", publish: params.publishAcceptedManifest },
    });
    return { ...applied, changed: staged.changed };
  });
}

async function prepareRequestedWorkerWorkspaceResult(params: {
  request: WorkerLocalWorkspaceReconcileRequest;
  stagingRoot: string;
  currentManifestRef: string;
  baseManifestRaw: string;
  currentManifestRaw: string;
  publishAcceptedManifest?: (accepted: {
    manifestRef: string;
    manifest: WorkerWorkspaceManifest;
    conflictPaths: string[];
  }) => Promise<void>;
}): Promise<{
  applyPreparedStagedResult(): Promise<void>;
  getAppliedWorkspaceResult(): WorkerWorkspaceApplyResult | undefined;
  verifyLocalStable(): Promise<void>;
  publishStagedResult(): Promise<void>;
  discardPreparedStagedResult(): Promise<void>;
}> {
  const stagedResult = params.request.stagedResult;
  if (!stagedResult) {
    throw new Error("Cloud workspace durable result staging was not requested");
  }
  const candidateRef = preparedWorkerWorkspaceResultRef(stagedResult.ref);
  const active = activeWorkspaceHashContext();
  const hashMemo = active?.memo ?? new Map();
  const metrics = active?.metrics;
  let appliedWorkspaceResult: WorkerWorkspaceApplyResult | undefined;
  await stageWorkerWorkspaceResult({
    root: params.request.localPath,
    stagingRoot: params.stagingRoot,
    stagedResultRef: candidateRef,
    baseManifestRef: params.request.baseManifestRef,
    currentManifestRef: params.currentManifestRef,
    baseManifestRaw: params.baseManifestRaw,
    currentManifestRaw: params.currentManifestRaw,
    assertCurrent: params.request.assertCurrent,
  });
  return {
    applyPreparedStagedResult: async () => {
      const root = await ensureWorkerWorkspaceResultRepository(
        params.request.localPath,
        params.request.assertCurrent,
      );
      appliedWorkspaceResult = await withWorkspaceHashMemo(
        hashMemo,
        async () =>
          await applyStagedWorkerWorkspaceResult({
            root,
            stagedResultRef: candidateRef,
            expectedBaseManifestRef: params.request.baseManifestRef,
            journal: params.request.journal,
            assertCurrent: params.request.assertCurrent,
            publishAcceptedManifest: params.publishAcceptedManifest,
          }),
        metrics,
      );
    },
    getAppliedWorkspaceResult: () => appliedWorkspaceResult,
    verifyLocalStable: async () => {
      if (!appliedWorkspaceResult) {
        throw new Error("Cloud workspace staged result has not been applied");
      }
      await appliedWorkspaceResult.verifyLocalStable();
    },
    publishStagedResult: async () => {
      const root = await ensureWorkerWorkspaceResultRepository(
        params.request.localPath,
        params.request.assertCurrent,
      );
      const commit = await requireGit(root, ["rev-parse", `${candidateRef}^{commit}`]);
      await updateWorkspaceResultRefs(
        root,
        [{ ref: stagedResult.ref, objectId: commit }, { ref: candidateRef }],
        params.request.assertCurrent,
      );
      // Final fences precede publishing. Preserve the canonical ref on any
      // SQLite failure so restart recovery can discover the verified result.
      params.request.assertCurrent?.();
      stagedResult.record(stagedResult.ref);
    },
    discardPreparedStagedResult: async () => {
      await deleteStagedWorkerWorkspaceResult({
        root: params.request.localPath,
        stagedResultRef: candidateRef,
        assertCurrent: params.request.assertCurrent,
      });
    },
  };
}

export async function deleteStagedWorkerWorkspaceResult(params: {
  root: string;
  stagedResultRef: string;
  assertCurrent?: () => void;
}): Promise<void> {
  const root = await fs.realpath(params.root);
  const stagedResultRef = requireWorkerResultStorageRef(params.stagedResultRef);
  await updateWorkspaceResultRefs(
    root,
    [
      { ref: stagedResultRef },
      ...(stagedResultRef.startsWith(`${WORKER_RESULT_REF_PREFIX}/`)
        ? [{ ref: preparedWorkerWorkspaceResultRef(stagedResultRef) }]
        : []),
    ],
    params.assertCurrent,
  );
}

export async function moveStagedWorkerWorkspaceResultToCleanup(params: {
  root: string;
  stagedResultRef: string;
  assertCurrent?: () => void;
}): Promise<string> {
  const root = await fs.realpath(params.root);
  const stagedResultRef = requireWorkerResultRef(params.stagedResultRef);
  const cleanupRef = cleanupWorkerWorkspaceResultRef(stagedResultRef);
  const commit = await requireGit(root, ["rev-parse", `${stagedResultRef}^{commit}`]);
  // Complete the ref move before removing the SQLite fence, keeping an
  // inspectable result on either side of a crash.
  await updateWorkspaceResultRefs(
    root,
    [
      { ref: cleanupRef, objectId: commit },
      { ref: stagedResultRef },
      { ref: preparedWorkerWorkspaceResultRef(stagedResultRef) },
    ],
    params.assertCurrent,
  );
  return cleanupRef;
}

export async function restoreStagedWorkerWorkspaceResultFromCleanup(params: {
  root: string;
  cleanupRef: string;
  stagedResultRef: string;
  assertCurrent?: () => void;
}): Promise<void> {
  const root = await fs.realpath(params.root);
  const cleanupRef = requireWorkerResultStorageRef(params.cleanupRef);
  if (!isWorkerWorkspaceResultCleanupRef(cleanupRef)) {
    throw new Error("Cloud workspace cleanup result reference is invalid");
  }
  const stagedResultRef = requireWorkerResultRef(params.stagedResultRef);
  const commit = await requireGit(root, ["rev-parse", `${cleanupRef}^{commit}`]);
  await updateWorkspaceResultRefs(
    root,
    [{ ref: stagedResultRef, objectId: commit }, { ref: cleanupRef }],
    params.assertCurrent,
  );
}

export async function deleteWorkerWorkspaceResultCleanupRefs(params: {
  root: string;
  retainedRefs?: () => ReadonlySet<string>;
}): Promise<void> {
  const root = await fs.realpath(params.root);
  const output = await requireGit(root, [
    "for-each-ref",
    "--format=%(refname)",
    `${WORKER_RESULT_CLEANUP_REF_PREFIX}/`,
  ]);
  const cleanupRefs = output.split("\n").filter(Boolean);
  if (cleanupRefs.length > 0) {
    await updateWorkspaceResultRefs(root, () => {
      // Read fences after inventory and the shared ref queue wait. Later
      // claims cannot appear in these immutable claim refs.
      const retainedRefs = params.retainedRefs?.();
      return cleanupRefs
        .map(requireWorkerResultStorageRef)
        .filter((ref) => !retainedRefs?.has(ref))
        .map((ref) => ({ ref }));
    });
  }
}

export const workerWorkspaceResultStaging = {
  prepareRequestedWorkerWorkspaceResult,
  stageWorkerWorkspaceResult,
};
