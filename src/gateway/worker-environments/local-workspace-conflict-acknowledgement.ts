import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readLiveRegistryWorktreeByPath } from "../../agents/worktrees/registry-read.js";
import { captureWorktreeRunEndContext } from "../../agents/worktrees/run-end-lifecycle.js";
import { withLocalWorkspaceStore, type LocalWorkspaceStore } from "./local-workspace-store.js";

function resolveCandidateBrowserPath(params: {
  cwd: string;
  fileRoot?: string;
  filePath: string;
  conflicts?: Record<string, unknown>;
}): string {
  const normalized = path.normalize(params.filePath).replaceAll("\\", "/");
  if (params.conflicts && Object.prototype.hasOwnProperty.call(params.conflicts, normalized)) {
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
  if (params.conflicts && Object.prototype.hasOwnProperty.call(params.conflicts, cwdCandidate)) {
    return cwdCandidate;
  }
  const base = params.fileRoot ?? params.cwd;
  const candidate = path.resolve(base, params.filePath);
  const rel = path.relative(params.cwd, candidate);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    const relPath = rel.replaceAll("\\", "/");
    if (params.conflicts && Object.prototype.hasOwnProperty.call(params.conflicts, relPath)) {
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

export async function resolveReconciledExpectedHash(params: {
  cwd?: string;
  fileRoot?: string;
  worktreeId?: string;
  path: string;
  expectedHash?: string;
  projectionPath?: string;
  conflicts?: Record<string, unknown>;
  assertCurrent?: () => void;
}): Promise<{
  effectiveExpectedHash?: string;
  reviewedGuestVersion?: { sha256?: string; mode?: number };
}> {
  let projectionPath = params.projectionPath;
  let conflicts = params.conflicts;
  params.assertCurrent?.();
  if (!projectionPath && (params.worktreeId || params.cwd)) {
    const context = captureWorktreeRunEndContext(process.env);
    const env = { ...process.env, ...context.environment };
    let worktreeId = params.worktreeId;
    if (!worktreeId && params.cwd) {
      const worktreeRecord = await readLiveRegistryWorktreeByPath(context, params.cwd);
      worktreeId = worktreeRecord?.id;
    }
    if (worktreeId) {
      await withLocalWorkspaceStore(
        { worktreeId, env, assertCurrent: params.assertCurrent },
        async (store) => {
          params.assertCurrent?.();
          const row = store.get();
          if (row?.projection_path) {
            projectionPath = row.projection_path;
            if (row.checkpoint_json) {
              try {
                // SAFETY: Checkpoint JSON deserializes to a record containing conflicts.
                const cp = JSON.parse(row.checkpoint_json) as {
                  conflicts?: Record<string, unknown>;
                };
                conflicts = cp.conflicts;
              } catch {
                // ignore
              }
            }
          }
        },
      );
    }
  }
  params.assertCurrent?.();
  if (projectionPath && params.cwd && params.expectedHash) {
    const browserPath = resolveCandidateBrowserPath({
      cwd: params.cwd,
      fileRoot: params.fileRoot,
      filePath: params.path,
      conflicts,
    });
    const hasConflict = Boolean(
      conflicts && Object.prototype.hasOwnProperty.call(conflicts, browserPath),
    );
    if (!hasConflict) {
      return { effectiveExpectedHash: params.expectedHash, reviewedGuestVersion: undefined };
    }
    const guestFile = path.join(projectionPath, browserPath);
    const guestStat = await fs.lstat(guestFile).catch(() => undefined);
    if (guestStat?.isFile()) {
      const guestBuf = await fs.readFile(guestFile).catch(() => undefined);
      const guestHash = guestBuf ? createHash("sha256").update(guestBuf).digest("hex") : undefined;
      if (guestHash && params.expectedHash === guestHash) {
        const reviewedGuestVersion = {
          sha256: guestHash,
          mode: guestStat.mode & 0o777,
        };
        const canonicalFile = path.join(params.cwd, browserPath);
        const canonicalBuf = await fs.readFile(canonicalFile).catch(() => undefined);
        const effectiveExpectedHash = canonicalBuf
          ? createHash("sha256").update(canonicalBuf).digest("hex")
          : params.expectedHash;
        return { effectiveExpectedHash, reviewedGuestVersion };
      }
    }
  }
  return { effectiveExpectedHash: params.expectedHash, reviewedGuestVersion: undefined };
}

export async function acknowledgeConflictInState(
  state: {
    current: () => LocalWorkspaceProjection;
    update: (patch: Record<string, unknown>) => Promise<void>;
  },
  filePath: string,
  reviewedGuestVersion?: { sha256?: string; mode?: number },
  assertCurrent?: () => void,
): Promise<void> {
  assertCurrent?.();
  const row = state.current();
  const checkpoint = row.checkpoint_json
    ? (JSON.parse(row.checkpoint_json) as Record<string, unknown>) // SAFETY: Checkpoint JSON deserializes to a key-value record.
    : {};
  const acknowledged = new Set(
    Array.isArray(checkpoint.acknowledgedPaths) ? checkpoint.acknowledgedPaths : [],
  );
  acknowledged.add(filePath);
  const acknowledgedGuestVersions = {
    // SAFETY: Acknowledged guest versions map stores reviewed hashes and modes.
    ...(checkpoint.acknowledgedGuestVersions as
      | Record<string, { sha256?: string; mode?: number }>
      | undefined),
    ...(reviewedGuestVersion ? { [filePath]: reviewedGuestVersion } : {}),
  };
  const previousRoot = checkpoint.previousRoot ?? row.baseline_ref ?? null;
  const resultingRoot = checkpoint.resultingRoot ?? row.baseline_ref ?? "";
  assertCurrent?.();
  await state.update({
    checkpoint_json: JSON.stringify({
      version: 1,
      kind: "scan",
      records: [],
      removed: [],
      ...checkpoint,
      previousRoot,
      resultingRoot,
      acknowledgedPaths: [...acknowledged],
      acknowledgedGuestVersions,
    }),
  });
}

export async function acknowledgeConflictInStore(
  store: LocalWorkspaceStore,
  filePath: string,
  reviewedGuestVersion?: { sha256?: string; mode?: number },
  assertCurrent?: () => void,
): Promise<void> {
  assertCurrent?.();
  const row = store.get();
  if (!row) {
    return;
  }
  const checkpoint = row.checkpoint_json
    ? (JSON.parse(row.checkpoint_json) as Record<string, unknown>) // SAFETY: Checkpoint JSON deserializes to a key-value record.
    : {};
  const acknowledged = new Set(
    Array.isArray(checkpoint.acknowledgedPaths) ? checkpoint.acknowledgedPaths : [],
  );
  acknowledged.add(filePath);
  const acknowledgedGuestVersions = {
    // SAFETY: Acknowledged guest versions map stores reviewed hashes and modes.
    ...(checkpoint.acknowledgedGuestVersions as
      | Record<string, { sha256?: string; mode?: number }>
      | undefined),
    ...(reviewedGuestVersion ? { [filePath]: reviewedGuestVersion } : {}),
  };
  const previousRoot = checkpoint.previousRoot ?? row.baseline_ref ?? null;
  const resultingRoot = checkpoint.resultingRoot ?? row.baseline_ref ?? "";
  assertCurrent?.();
  await store.update(row, {
    checkpoint_json: JSON.stringify({
      version: 1,
      kind: "scan",
      records: [],
      removed: [],
      ...checkpoint,
      previousRoot,
      resultingRoot,
      acknowledgedPaths: [...acknowledged],
      acknowledgedGuestVersions,
    }),
  });
}

export async function acknowledgeLocalWorkspaceConflict(params: {
  cwd?: string;
  worktreeId?: string;
  path: string;
  reviewedGuestVersion?: { sha256?: string; mode?: number };
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
