import fs from "node:fs/promises";
import path from "node:path";
import type { LocalWorkspaceSyncTarget as Direction } from "./local-workspace-checkpoint.js";
import type { LocalWorkspaceManifestCheckpoint } from "./local-workspace-manifest-scan.js";
import {
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";

export type LocalWorkspaceConflictRecord = Record<
  string,
  { sha256?: string; size?: number; type?: string; target?: string }
>;

export type LocalWorkspaceCheckpointRecord = LocalWorkspaceManifestCheckpoint & {
  conflicts?: LocalWorkspaceConflictRecord;
  acknowledgedPaths?: string[];
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

async function synchronizeResolvedCanonicalPaths(
  canonicalRoot: string,
  projectionRoot: string,
  resolvedPaths: string[],
): Promise<void> {
  for (const resolvedPath of resolvedPaths) {
    const src = path.join(canonicalRoot, resolvedPath);
    const dest = path.join(projectionRoot, resolvedPath);
    const stats = await fs.lstat(src).catch(() => undefined);
    if (!stats) {
      await fs.rm(dest, { force: true, recursive: true });
    } else if (stats.isSymbolicLink()) {
      const targetLink = await fs.readlink(src);
      await fs.rm(dest, { force: true, recursive: true });
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.symlink(targetLink, dest);
    } else if (stats.isFile()) {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      await fs.chmod(dest, stats.mode);
    }
  }
}

export async function commitLocalWorkspaceReconciliation(params: {
  conflictPaths: string[];
  resolvedCanonicalPaths?: string[];
  resolvedManifest?: WorkerWorkspaceManifest;
  resolvedManifestRef?: string;
  checkpoint?: LocalWorkspaceManifestCheckpoint & {
    conflicts?: LocalWorkspaceConflictRecord;
    acknowledgedPaths?: string[];
  };
  snapshot: {
    current: WorkerWorkspaceManifest;
    currentManifestRaw: string;
    currentManifestRef: string;
  };
  refresh?: boolean;
  target: Direction;
  worktreePath: string;
  projectionPath: string;
  update: (
    patch: Record<string, unknown>,
    checkpoint?: LocalWorkspaceManifestCheckpoint,
  ) => Promise<void>;
  replaceBaseline: (raw: string, ref: string, patch: Record<string, unknown>) => Promise<void>;
}): Promise<void> {
  if (params.conflictPaths.length) {
    const conflicts = buildLocalWorkspaceConflictRecord(
      params.conflictPaths,
      params.resolvedManifest,
    );
    await params.update({
      journal_json: null,
      journal_pack: null,
      checkpoint_json: JSON.stringify({
        ...(params.checkpoint ?? params.snapshot),
        conflicts,
      }),
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
    await synchronizeResolvedCanonicalPaths(
      params.worktreePath,
      params.projectionPath,
      params.resolvedCanonicalPaths,
    );
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
