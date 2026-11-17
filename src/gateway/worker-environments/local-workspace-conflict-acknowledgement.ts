import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readLiveRegistryWorktreeByPath } from "../../agents/worktrees/registry-read.js";
import { captureWorktreeRunEndContext } from "../../agents/worktrees/run-end-lifecycle.js";
import { root as openFsSafeRoot } from "../../infra/fs-safe.js";
import {
  withLocalWorkspaceStore,
  type LocalWorkspaceProjection,
  type LocalWorkspaceStore,
} from "./local-workspace-store.js";
import type { WorkspaceGuestVersion } from "./workspace-manifest-comparison.js";

function resolveCandidateBrowserPath(params: {
  cwd: string;
  fileRoot?: string;
  filePath: string;
  conflicts?: Record<string, unknown>;
}): string {
  const normalized = path.normalize(params.filePath).replaceAll("\\", "/");
  if (params.conflicts && Object.hasOwn(params.conflicts, normalized)) {
    return normalized;
  }
  if (path.isAbsolute(params.filePath)) {
    const rel = path.relative(params.cwd, path.resolve(params.filePath));
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rel.replaceAll("\\", "/");
    }
  }
  const cwdCandidate = path
    .relative(params.cwd, path.resolve(params.cwd, params.filePath))
    .replaceAll("\\", "/");
  if (params.conflicts && Object.hasOwn(params.conflicts, cwdCandidate)) {
    return cwdCandidate;
  }
  const base = params.fileRoot ?? params.cwd;
  const candidate = path.resolve(base, params.filePath);
  const rel = path.relative(params.cwd, candidate);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    const relPath = rel.replaceAll("\\", "/");
    if (params.conflicts && Object.hasOwn(params.conflicts, relPath)) {
      return relPath;
    }
    if (!params.fileRoot || params.fileRoot === params.cwd) {
      return relPath;
    }
  }
  if (!cwdCandidate.startsWith("..") && !path.isAbsolute(cwdCandidate)) {
    return cwdCandidate;
  }
  return normalized.replace(/^(\.\.(\/|\\|$))+/, "");
}

export type LocalWorkspaceGuestVersion = WorkspaceGuestVersion;

/** Bound the guest probe: manifests normally cap file bytes, but the projection is guest-writable. */
const MAX_GUEST_VERSION_BYTES = 8 * 1024 * 1024;

async function readGuestVersion(
  projectionPath: string,
  browserPath: string,
): Promise<LocalWorkspaceGuestVersion | undefined> {
  const full = path.join(projectionPath, browserPath);
  const stat = await fs.lstat(full).catch(() => undefined);
  if (!stat) {
    return { type: "missing" };
  }
  const mode = stat.mode & 0o777;
  if (stat.isSymbolicLink()) {
    return { type: "symlink", mode, target: await fs.readlink(full) };
  }
  if (stat.isDirectory()) {
    return { type: "directory", mode };
  }
  if (!stat.isFile()) {
    return undefined;
  }
  const projectionFs = await openFsSafeRoot(projectionPath);
  const read = await projectionFs
    .read(browserPath, { maxBytes: MAX_GUEST_VERSION_BYTES })
    .catch(() => undefined);
  if (!read) {
    return undefined;
  }
  return {
    type: "file",
    sha256: createHash("sha256").update(read.buffer).digest("hex"),
    mode,
  };
}

function hasCheckpointConflict(checkpoint: Record<string, unknown>, filePath: string): boolean {
  const conflicts = checkpoint.conflicts as Record<string, unknown> | undefined;
  return Boolean(conflicts && Object.hasOwn(conflicts, filePath));
}

function needsAcknowledgement(checkpoint: Record<string, unknown>, filePath: string): boolean {
  return (
    hasCheckpointConflict(checkpoint, filePath) ||
    (Array.isArray(checkpoint.acknowledgedPaths) &&
      checkpoint.acknowledgedPaths.includes(filePath)) ||
    (Array.isArray(checkpoint.resolvedPaths) && checkpoint.resolvedPaths.includes(filePath))
  );
}

async function acknowledgeCheckpoint(
  checkpoint: Record<string, unknown>,
  filePath: string,
  projectionPath: string | undefined,
  baselineRef: string | null | undefined,
  reviewedGuestVersion: WorkspaceGuestVersion | undefined,
  pending: boolean,
): Promise<string | undefined> {
  if (!pending && !needsAcknowledgement(checkpoint, filePath)) {
    return undefined;
  }
  const acknowledged = new Set(
    Array.isArray(checkpoint.acknowledgedPaths) ? checkpoint.acknowledgedPaths : [],
  );
  acknowledged.add(filePath);
  const acknowledgedGuestVersions = {
    // SAFETY: Acknowledged guest versions map stores reviewed hashes and modes.
    ...(checkpoint.acknowledgedGuestVersions as
      | Record<string, LocalWorkspaceGuestVersion>
      | undefined),
  };
  const conflictVersion = (
    checkpoint.conflicts as Record<string, WorkspaceGuestVersion> | undefined
  )?.[filePath];
  const version =
    reviewedGuestVersion ??
    acknowledgedGuestVersions[filePath] ??
    conflictVersion ??
    (pending && projectionPath ? await readGuestVersion(projectionPath, filePath) : undefined);
  if (version) {
    acknowledgedGuestVersions[filePath] = version;
  }
  const previousRoot = checkpoint.previousRoot ?? baselineRef ?? null;
  const resultingRoot = checkpoint.resultingRoot ?? baselineRef ?? "";
  return JSON.stringify({
    version: 1,
    kind: "scan",
    records: [],
    removed: [],
    ...checkpoint,
    previousRoot,
    resultingRoot,
    acknowledgedPaths: [...acknowledged],
    acknowledgedGuestVersions,
  });
}

export async function resolveReconciledExpectedHash(params: {
  cwd?: string;
  fileRoot?: string;
  path: string;
  expectedHash?: string;
  projectionPath?: string;
  conflicts?: Record<string, unknown>;
  assertCurrent?: () => void;
}): Promise<{
  effectiveExpectedHash?: string;
  reviewedGuestVersion?: LocalWorkspaceGuestVersion;
}> {
  params.assertCurrent?.();
  if (!params.projectionPath || !params.cwd || !params.expectedHash) {
    return { effectiveExpectedHash: params.expectedHash };
  }
  const browserPath = resolveCandidateBrowserPath({
    cwd: params.cwd,
    fileRoot: params.fileRoot,
    filePath: params.path,
    conflicts: params.conflicts,
  });
  if (!params.conflicts || !Object.hasOwn(params.conflicts, browserPath)) {
    return { effectiveExpectedHash: params.expectedHash };
  }
  const guestVersion = await readGuestVersion(params.projectionPath, browserPath);
  if (guestVersion?.type !== "file" || params.expectedHash !== guestVersion.sha256) {
    return { effectiveExpectedHash: params.expectedHash };
  }
  const canonicalBuf = await fs.readFile(path.join(params.cwd, browserPath)).catch(() => undefined);
  return {
    effectiveExpectedHash: canonicalBuf
      ? createHash("sha256").update(canonicalBuf).digest("hex")
      : params.expectedHash,
    reviewedGuestVersion: guestVersion,
  };
}

export async function acknowledgeConflictInState(
  state: {
    current: () => LocalWorkspaceProjection;
    update: (patch: Record<string, unknown>) => Promise<void>;
  },
  filePath: string,
  reviewedGuestVersion?: LocalWorkspaceGuestVersion,
  assertCurrent?: () => void,
): Promise<void> {
  assertCurrent?.();
  const row = state.current();
  const pending = Boolean(row.pending_ref || row.pending_target);
  if (!row.checkpoint_json && !pending) {
    return;
  }
  const checkpoint = row.checkpoint_json
    ? (JSON.parse(row.checkpoint_json) as Record<string, unknown>) // SAFETY: Checkpoint JSON deserializes to a key-value record.
    : {};
  const checkpointJson = await acknowledgeCheckpoint(
    checkpoint,
    filePath,
    row.projection_path,
    row.baseline_ref,
    reviewedGuestVersion,
    pending,
  );
  if (!checkpointJson) {
    return;
  }
  assertCurrent?.();
  await state.update({ checkpoint_json: checkpointJson });
}

export async function acknowledgeConflictInStore(
  store: LocalWorkspaceStore,
  filePath: string,
  reviewedGuestVersion?: LocalWorkspaceGuestVersion,
  assertCurrent?: () => void,
): Promise<void> {
  assertCurrent?.();
  const row = store.get();
  const pending = Boolean(row?.pending_ref || row?.pending_target);
  if (!row || (!row.checkpoint_json && !pending)) {
    return;
  }
  const checkpoint = row.checkpoint_json
    ? (JSON.parse(row.checkpoint_json) as Record<string, unknown>) // SAFETY: Checkpoint JSON deserializes to a key-value record.
    : {};
  const checkpointJson = await acknowledgeCheckpoint(
    checkpoint,
    filePath,
    row.projection_path,
    row.baseline_ref,
    reviewedGuestVersion,
    pending,
  );
  if (!checkpointJson) {
    return;
  }
  assertCurrent?.();
  await store.update(row, { checkpoint_json: checkpointJson });
}

export async function acknowledgeLocalWorkspaceConflict(params: {
  cwd?: string;
  worktreeId?: string;
  path: string;
  reviewedGuestVersion?: LocalWorkspaceGuestVersion;
  assertCurrent?: () => void;
}): Promise<void> {
  const context = captureWorktreeRunEndContext(process.env);
  const env = { ...process.env, ...context.environment };
  params.assertCurrent?.();
  let worktreeId = params.worktreeId;
  const worktreeRecord = params.cwd
    ? await readLiveRegistryWorktreeByPath(context, params.cwd)
    : undefined;
  params.assertCurrent?.();
  if (worktreeRecord) {
    if (worktreeId && worktreeRecord.id !== worktreeId) {
      throw new Error("Local sandbox workspace owner changed");
    }
    worktreeId = worktreeRecord.id;
  }
  if (!worktreeId) {
    return;
  }
  await withLocalWorkspaceStore(
    { worktreeId, env, assertCurrent: params.assertCurrent },
    async (store) => {
      params.assertCurrent?.();
      const row = store.get();
      if (!row) {
        return;
      }
      if (
        worktreeRecord &&
        (row.session_key !== worktreeRecord.ownerId || row.worktree_id !== worktreeRecord.id)
      ) {
        throw new Error("Local sandbox workspace owner changed");
      }
      await acknowledgeConflictInStore(
        store,
        params.path,
        params.reviewedGuestVersion,
        params.assertCurrent,
      );
    },
  );
}
