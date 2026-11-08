import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readLiveRegistryWorktreeByPath } from "../../agents/worktrees/registry-read.js";
import { captureWorktreeRunEndContext } from "../../agents/worktrees/run-end-lifecycle.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";

export async function resolveReconciledExpectedHash(params: {
  cwd?: string;
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
    const browserPath = path
      .normalize(params.path)
      .replace(/^(\.\.(\/|\\|$))+/, "")
      .replaceAll("\\", "/");
    const guestFile = path.join(projectionPath, browserPath);
    const guestStat = await fs.lstat(guestFile).catch(() => undefined);
    if (guestStat?.isFile()) {
      const guestBuf = await fs.readFile(guestFile).catch(() => undefined);
      const guestHash = guestBuf ? createHash("sha256").update(guestBuf).digest("hex") : undefined;
      // SAFETY: Conflicts record indexed by relative browser workspace path.
      const recordedConflict = conflicts?.[browserPath] as { sha256?: string } | undefined;
      if (
        guestHash &&
        params.expectedHash === guestHash &&
        (!recordedConflict?.sha256 || recordedConflict.sha256 === guestHash)
      ) {
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
  let worktreeRecord = params.cwd
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
      const checkpoint = row.checkpoint_json
        ? (JSON.parse(row.checkpoint_json) as Record<string, unknown>) // SAFETY: Checkpoint JSON deserializes to a key-value record.
        : {};
      const acknowledged = new Set(
        Array.isArray(checkpoint.acknowledgedPaths) ? checkpoint.acknowledgedPaths : [],
      );
      acknowledged.add(params.path);
      const acknowledgedGuestVersions = {
        // SAFETY: Acknowledged guest versions map stores reviewed hashes and modes.
        ...(checkpoint.acknowledgedGuestVersions as
          | Record<string, { sha256?: string; mode?: number }>
          | undefined),
        ...(params.reviewedGuestVersion ? { [params.path]: params.reviewedGuestVersion } : {}),
      };
      const previousRoot = checkpoint.previousRoot ?? row.baseline_ref ?? null;
      const resultingRoot = checkpoint.resultingRoot ?? row.baseline_ref ?? "";
      params.assertCurrent?.();
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
    },
  );
}
