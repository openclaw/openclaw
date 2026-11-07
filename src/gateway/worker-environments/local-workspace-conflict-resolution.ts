import fs from "node:fs/promises";
import path from "node:path";
import { root as openFsSafeRoot } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import type { LocalWorkspaceSyncTarget as Direction } from "./local-workspace-checkpoint.js";
import type { LocalWorkspaceManifestCheckpoint } from "./local-workspace-manifest-scan.js";
import {
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";

type LocalWorkspaceConflictRecord = Record<
  string,
  { sha256?: string; size?: number; type?: string; target?: string }
>;

export type LocalWorkspaceCheckpointRecord = LocalWorkspaceManifestCheckpoint & {
  conflicts?: LocalWorkspaceConflictRecord;
  acknowledgedPaths?: string[];
  resolvedPaths?: string[];
};

function buildLocalWorkspaceConflictRecord(
  conflictPaths: string[],
  resolvedManifest?: WorkerWorkspaceManifest,
): LocalWorkspaceConflictRecord {
  const conflicts: LocalWorkspaceConflictRecord = {};
  if (resolvedManifest) {
    for (const entryPath of conflictPaths) {
      const entry = resolvedManifest.entries.find(
        (e: WorkerWorkspaceManifestEntry) => e.path === entryPath,
      );
      if (entry) {
        conflicts[entryPath] = {
          type: entry.type,
          sha256: entry.type === "file" ? entry.sha256 : undefined,
          size: entry.type === "file" ? entry.size : undefined,
          target: entry.type === "symlink" ? entry.target : undefined,
        };
      } else {
        conflicts[entryPath] = { type: "missing" };
      }
    }
  }
  return conflicts;
}

async function synchronizeResolvedCanonicalPaths(params: {
  canonicalRoot: string;
  projectionRoot: string;
  resolvedPaths: string[];
  assertCurrent?: () => void;
}): Promise<void> {
  const canonicalFs = await openFsSafeRoot(params.canonicalRoot, {
    assertBeforeMutation: params.assertCurrent,
  });
  const projectionFs = await openFsSafeRoot(params.projectionRoot, {
    assertBeforeMutation: params.assertCurrent,
  });
  for (const resolvedPath of params.resolvedPaths) {
    params.assertCurrent?.();
    const src = path.join(params.canonicalRoot, resolvedPath);
    const stats = await fs.lstat(src).catch(() => undefined);
    if (!stats) {
      await projectionFs.remove(resolvedPath).catch(() => undefined);
    } else if (stats.isSymbolicLink()) {
      const targetLink = await fs.readlink(src);
      const targetAbsolute = path.resolve(path.dirname(src), targetLink);
      if (path.isAbsolute(targetLink) || !isPathInside(params.canonicalRoot, targetAbsolute)) {
        throw new Error(`Resolved symlink escapes workspace root: ${resolvedPath}`);
      }
      await projectionFs.remove(resolvedPath).catch(() => undefined);
      const dest = path.join(params.projectionRoot, resolvedPath);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.symlink(targetLink, dest);
    } else if (stats.isFile()) {
      const readResult = await canonicalFs.read(resolvedPath);
      const destStats = await fs
        .lstat(path.join(params.projectionRoot, resolvedPath))
        .catch(() => undefined);
      if (destStats?.isSymbolicLink()) {
        await projectionFs.remove(resolvedPath).catch(() => undefined);
      }
      await projectionFs.write(resolvedPath, readResult.buffer, {
        mode: stats.mode & 0o777,
        renameIdentity: "strict",
        assertBeforeMutation: params.assertCurrent,
      });
    }
  }
}

export async function commitLocalWorkspaceReconciliation(params: {
  conflictPaths: string[];
  resolvedCanonicalPaths?: string[];
  resolvedManifest?: WorkerWorkspaceManifest;
  resolvedManifestRef?: string;
  checkpoint?: LocalWorkspaceCheckpointRecord;
  snapshot: {
    current: WorkerWorkspaceManifest;
    currentManifestRaw: string;
    currentManifestRef: string;
  };
  refresh?: boolean;
  target: Direction;
  worktreePath: string;
  projectionPath: string;
  baselineRef?: string | null;
  assertCurrent?: () => void;
  update: (
    patch: Record<string, unknown>,
    checkpoint?: LocalWorkspaceManifestCheckpoint,
  ) => Promise<void>;
  replaceBaseline: (raw: string, ref: string, patch: Record<string, unknown>) => Promise<void>;
}): Promise<void> {
  if (params.conflictPaths.length) {
    if (params.resolvedCanonicalPaths?.length) {
      await synchronizeResolvedCanonicalPaths({
        canonicalRoot: params.worktreePath,
        projectionRoot: params.projectionPath,
        resolvedPaths: params.resolvedCanonicalPaths,
        assertCurrent: params.assertCurrent,
      });
    }
    const previousResolved = params.checkpoint?.resolvedPaths ?? [];
    const resolvedPaths = [
      ...new Set([...previousResolved, ...(params.resolvedCanonicalPaths ?? [])]),
    ];
    const conflicts = buildLocalWorkspaceConflictRecord(
      params.conflictPaths,
      params.resolvedManifest,
    );
    const baselineRef = params.checkpoint?.previousRoot ?? params.baselineRef ?? null;
    const checkpointRecord: LocalWorkspaceCheckpointRecord = {
      version: 1,
      kind: "scan",
      resultingRoot: params.checkpoint?.resultingRoot ?? baselineRef ?? "",
      records: params.checkpoint?.records ?? [],
      removed: params.checkpoint?.removed ?? [],
      baseManifestRef: params.checkpoint?.baseManifestRef ?? params.snapshot.currentManifestRef,
      currentManifestRef:
        params.checkpoint?.currentManifestRef ?? params.snapshot.currentManifestRef,
      baseManifestRaw: params.checkpoint?.baseManifestRaw ?? params.snapshot.currentManifestRaw,
      currentManifestRaw:
        params.checkpoint?.currentManifestRaw ?? params.snapshot.currentManifestRaw,
      buildCacheInputs: params.checkpoint?.buildCacheInputs ?? [],
      // SAFETY: Preserve all existing fields from previous checkpoint record when present.
      ...(params.checkpoint as Record<string, unknown> | undefined),
      previousRoot: baselineRef,
      conflicts,
      acknowledgedPaths: params.checkpoint?.acknowledgedPaths,
      resolvedPaths,
    };
    await params.update({
      journal_json: null,
      journal_pack: null,
      checkpoint_json: JSON.stringify(checkpointRecord),
    });
    return;
  }
  if (params.refresh && params.target === "canonical") {
    await params.update({
      pending_target: "projection",
      journal_json: null,
      journal_pack: null,
    });
    return;
  }
  if (params.resolvedCanonicalPaths?.length) {
    await synchronizeResolvedCanonicalPaths({
      canonicalRoot: params.worktreePath,
      projectionRoot: params.projectionPath,
      resolvedPaths: params.resolvedCanonicalPaths,
      assertCurrent: params.assertCurrent,
    });
  }
  const patch = {
    ...(params.refresh ? { base_commit: params.snapshot.current.baseCommit! } : {}),
    pending_target: null,
    journal_json: null,
    journal_pack: null,
  };
  if (
    params.resolvedCanonicalPaths?.length &&
    params.resolvedManifest &&
    params.resolvedManifestRef
  ) {
    const raw = serializeWorkerWorkspaceManifest(params.resolvedManifest);
    await params.replaceBaseline(raw, params.resolvedManifestRef, patch);
  } else if (params.checkpoint) {
    await params.update(patch, params.checkpoint);
  } else {
    await params.replaceBaseline(
      params.snapshot.currentManifestRaw,
      params.snapshot.currentManifestRef,
      patch,
    );
  }
}
