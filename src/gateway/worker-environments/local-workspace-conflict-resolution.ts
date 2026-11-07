import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { root as openFsSafeRoot } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import type { LocalWorkspaceSyncTarget as Direction } from "./local-workspace-checkpoint.js";
import type { LocalWorkspaceManifestCheckpoint } from "./local-workspace-manifest-scan.js";
import type { LocalWorkspaceProjection } from "./local-workspace-store.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";
import {
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { workspacePathAncestors } from "./workspace-path-ancestors.js";

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
      } else if (resolvedManifest.directories?.includes(entryPath)) {
        conflicts[entryPath] = { type: "directory" };
      } else {
        conflicts[entryPath] = { type: "missing" };
      }
    }
  }
  return conflicts;
}

type LiveNode =
  | { type: "missing" }
  | { type: "directory" }
  | { type: "symlink"; target: string }
  | { type: "file"; sha256: string; mode?: number };

async function inspectLiveNode(
  root: string,
  relativePath: string,
  fsRoot?: { read: (p: string) => Promise<{ buffer: Uint8Array }> },
): Promise<LiveNode> {
  const fullPath = path.join(root, relativePath);
  const stat = await fs.lstat(fullPath).catch(() => undefined);
  if (!stat) {
    return { type: "missing" };
  }
  if (stat.isDirectory()) {
    return { type: "directory" };
  }
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(fullPath);
    return { type: "symlink", target };
  }
  if (stat.isFile()) {
    let buf: Uint8Array | undefined;
    if (fsRoot) {
      buf = (await fsRoot.read(relativePath).catch(() => undefined))?.buffer;
    }
    if (!buf) {
      buf = await fs.readFile(fullPath).catch(() => undefined);
    }
    const sha256 = buf ? createHash("sha256").update(buf).digest("hex") : "";
    return { type: "file", sha256, mode: stat.mode & 0o777 };
  }
  return { type: "missing" };
}

function liveMatchesExpected(
  live: LiveNode,
  expected: { type?: string; sha256?: string; target?: string; mode?: number },
): boolean {
  if (expected.type && expected.type !== "diverged" && live.type !== expected.type) {
    return false;
  }
  if (live.type === "file") {
    if (expected.sha256 && live.sha256 !== expected.sha256) {
      return false;
    }
    if (expected.mode !== undefined && live.mode !== undefined && live.mode !== expected.mode) {
      return false;
    }
  }
  if (live.type === "symlink" && expected.target && live.target !== expected.target) {
    return false;
  }
  return true;
}

function nodesEqual(a: LiveNode, b: LiveNode): boolean {
  if (a.type !== b.type) {
    return false;
  }
  if (a.type === "symlink" && b.type === "symlink") {
    return a.target === b.target;
  }
  if (a.type === "file" && b.type === "file") {
    return (
      a.sha256 === b.sha256 && (a.mode === undefined || b.mode === undefined || a.mode === b.mode)
    );
  }
  return true;
}

export async function synchronizeResolvedCanonicalPaths(params: {
  canonicalRoot: string;
  projectionRoot: string;
  resolvedPaths: string[];
  conflicts?: LocalWorkspaceConflictRecord;
  assertCurrent?: () => void;
  divergedPaths?: Set<string>;
}): Promise<void> {
  const canonicalFs = await openFsSafeRoot(params.canonicalRoot, {
    assertBeforeMutation: params.assertCurrent,
  });
  const projectionFs = await openFsSafeRoot(params.projectionRoot, {
    assertBeforeMutation: params.assertCurrent,
  });
  const realProjectionRoot = await fs.realpath(params.projectionRoot);
  for (const resolvedPath of params.resolvedPaths) {
    params.assertCurrent?.();
    const src = path.join(params.canonicalRoot, resolvedPath);
    const dest = path.join(params.projectionRoot, resolvedPath);
    const destDir = path.dirname(dest);
    if (
      !isPathInside(params.projectionRoot, dest) ||
      !isPathInside(params.projectionRoot, destDir)
    ) {
      throw new Error(`Resolved path escapes projection root: ${resolvedPath}`);
    }
    const resolvedDestDirAncestor = resolvePathViaExistingAncestorSync(destDir);
    if (!isPathInside(realProjectionRoot, resolvedDestDirAncestor)) {
      throw new Error(`Resolved path directory escapes projection root: ${resolvedPath}`);
    }
    let checkPath = params.projectionRoot;
    const relativeSegments = path
      .relative(params.projectionRoot, destDir)
      .split(path.sep)
      .filter(Boolean);
    for (const segment of relativeSegments) {
      checkPath = path.join(checkPath, segment);
      const ancestorStat = await fs.lstat(checkPath).catch(() => undefined);
      if (ancestorStat?.isSymbolicLink()) {
        throw new Error(`Resolved path directory ancestor is a symlink: ${resolvedPath}`);
      }
    }

    const liveGuestNode = await inspectLiveNode(params.projectionRoot, resolvedPath, projectionFs);
    const canonicalNode = await inspectLiveNode(params.canonicalRoot, resolvedPath, canonicalFs);
    const expectedGuestConflict = params.conflicts?.[resolvedPath];

    if (expectedGuestConflict && !nodesEqual(liveGuestNode, canonicalNode)) {
      if (!liveMatchesExpected(liveGuestNode, expectedGuestConflict)) {
        params.divergedPaths?.add(resolvedPath);
        continue;
      }
    }

    const stats = await fs.lstat(src).catch(() => undefined);
    if (!stats) {
      const destStats = await fs.lstat(dest).catch(() => undefined);
      if (destStats) {
        params.assertCurrent?.();
        await projectionFs.remove(resolvedPath);
        params.assertCurrent?.();
      }
    } else if (stats.isSymbolicLink()) {
      const targetLink = await fs.readlink(src);
      const targetAbsolute = path.resolve(path.dirname(src), targetLink);
      if (path.isAbsolute(targetLink) || !isPathInside(params.canonicalRoot, targetAbsolute)) {
        throw new Error(`Resolved symlink escapes workspace root: ${resolvedPath}`);
      }
      params.assertCurrent?.();
      const destStats = await fs.lstat(dest).catch(() => undefined);
      if (destStats) {
        params.assertCurrent?.();
        await projectionFs.remove(resolvedPath);
        params.assertCurrent?.();
      }
      params.assertCurrent?.();
      await fs.mkdir(destDir, { recursive: true });
      params.assertCurrent?.();
      await fs.rm(dest, { force: true, recursive: true });
      params.assertCurrent?.();
      await fs.symlink(targetLink, dest);
      params.assertCurrent?.();
    } else if (stats.isFile()) {
      const readResult = await canonicalFs.read(resolvedPath);
      params.assertCurrent?.();
      const destStats = await fs.lstat(dest).catch(() => undefined);
      if (destStats && !destStats.isFile()) {
        params.assertCurrent?.();
        await projectionFs.remove(resolvedPath);
        params.assertCurrent?.();
      }
      await projectionFs.write(resolvedPath, readResult.buffer, {
        mode: stats.mode & 0o777,
        renameIdentity: "strict",
        assertBeforeMutation: params.assertCurrent,
      });
      params.assertCurrent?.();
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
    baseManifestRaw?: string;
    baseManifestRef?: string;
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
  baselineDocument?: () => Promise<{ rawManifest: string; manifestRef: string }>;
}): Promise<void> {
  const divergedPaths = new Set<string>();
  if (params.conflictPaths.length) {
    if (params.resolvedCanonicalPaths?.length) {
      await synchronizeResolvedCanonicalPaths({
        canonicalRoot: params.worktreePath,
        projectionRoot: params.projectionPath,
        resolvedPaths: params.resolvedCanonicalPaths,
        conflicts: params.checkpoint?.conflicts,
        assertCurrent: params.assertCurrent,
        divergedPaths,
      });
    }
    const previousResolved = params.checkpoint?.resolvedPaths ?? [];
    const resolvedPaths = [
      ...new Set([
        ...previousResolved,
        ...(params.resolvedCanonicalPaths?.filter((p) => !divergedPaths.has(p)) ?? []),
      ]),
    ];
    const currentConflicts = buildLocalWorkspaceConflictRecord(
      params.conflictPaths,
      params.snapshot.current,
    );
    const conflicts: LocalWorkspaceConflictRecord = {};
    for (const conflictPath of params.conflictPaths) {
      const existing = params.checkpoint?.conflicts?.[conflictPath];
      const current = currentConflicts[conflictPath];
      if (existing) {
        conflicts[conflictPath] = existing;
      } else if (current) {
        conflicts[conflictPath] = current;
      } else {
        conflicts[conflictPath] = { type: "missing" };
      }
    }
    const baselineRef = params.checkpoint?.previousRoot ?? params.baselineRef ?? null;
    const checkpointRecord: LocalWorkspaceCheckpointRecord = {
      version: 1,
      kind: "scan",
      resultingRoot: params.checkpoint?.resultingRoot ?? baselineRef ?? "",
      records: params.checkpoint?.records ?? [],
      removed: params.checkpoint?.removed ?? [],
      baseManifestRef:
        params.checkpoint?.baseManifestRef ??
        params.snapshot.baseManifestRef ??
        params.snapshot.currentManifestRef,
      currentManifestRef:
        params.checkpoint?.currentManifestRef ?? params.snapshot.currentManifestRef,
      baseManifestRaw:
        params.checkpoint?.baseManifestRaw ??
        params.snapshot.baseManifestRaw ??
        params.snapshot.currentManifestRaw,
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
      conflicts: params.checkpoint?.conflicts,
      assertCurrent: params.assertCurrent,
      divergedPaths,
    });
  }
  const baselineDoc = params.baselineDocument ? await params.baselineDocument() : undefined;
  const baseManifestRaw =
    baselineDoc?.rawManifest ??
    params.checkpoint?.baseManifestRaw ??
    params.snapshot.baseManifestRaw ??
    params.snapshot.currentManifestRaw;
  const baseManifestRef =
    baselineDoc?.manifestRef ??
    params.checkpoint?.baseManifestRef ??
    params.snapshot.baseManifestRef ??
    params.snapshot.currentManifestRef;
  if (divergedPaths.size > 0) {
    const conflicts: LocalWorkspaceConflictRecord = {
      ...params.checkpoint?.conflicts,
    };
    for (const divergedPath of divergedPaths) {
      conflicts[divergedPath] = params.checkpoint?.conflicts?.[divergedPath] ?? {
        type: "conflict",
      };
    }
    const resolvedPaths = [
      ...new Set([
        ...(params.checkpoint?.resolvedPaths ?? []),
        ...(params.resolvedCanonicalPaths ?? []),
      ]),
    ].filter((p) => !divergedPaths.has(p));
    const checkpointRecord: LocalWorkspaceCheckpointRecord = {
      version: 1,
      kind: "scan",
      resultingRoot: params.checkpoint?.resultingRoot ?? params.baselineRef ?? "",
      records: params.checkpoint?.records ?? [],
      removed: params.checkpoint?.removed ?? [],
      baseManifestRef,
      currentManifestRef:
        params.checkpoint?.currentManifestRef ?? params.snapshot.currentManifestRef,
      baseManifestRaw,
      currentManifestRaw:
        params.checkpoint?.currentManifestRaw ?? params.snapshot.currentManifestRaw,
      buildCacheInputs: params.checkpoint?.buildCacheInputs ?? [],
      // SAFETY: Preserve all existing fields from previous checkpoint record when present.
      ...(params.checkpoint as Record<string, unknown> | undefined),
      previousRoot: params.checkpoint?.previousRoot ?? params.baselineRef ?? null,
      conflicts,
      acknowledgedPaths: params.checkpoint?.acknowledgedPaths?.filter((p) => !divergedPaths.has(p)),
      resolvedPaths,
    };
    await params.update({
      journal_json: null,
      journal_pack: null,
      checkpoint_json: JSON.stringify(checkpointRecord),
    });
    return;
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
    baseManifestRaw &&
    baseManifestRef
  ) {
    const base = parseWorkerWorkspaceManifest(
      baseManifestRaw,
      baseManifestRef,
      params.checkpoint?.buildCacheInputs,
      "stored",
    );
    const entriesMap = new Map<string, WorkerWorkspaceManifestEntry>();
    for (const entry of base.entries) {
      entriesMap.set(entry.path, entry);
    }
    const resolvedSet = new Set(params.resolvedCanonicalPaths);
    for (const resolvedEntry of params.resolvedManifest.entries) {
      if (resolvedSet.has(resolvedEntry.path)) {
        entriesMap.set(resolvedEntry.path, resolvedEntry);
      }
    }
    for (const resolvedPath of params.resolvedCanonicalPaths) {
      if (!params.resolvedManifest.entries.some((e) => e.path === resolvedPath)) {
        entriesMap.delete(resolvedPath);
      }
    }
    const directories = new Set<string>(base.directories ?? []);
    for (const entry of entriesMap.values()) {
      for (const ancestor of workspacePathAncestors(entry.path)) {
        directories.add(ancestor);
      }
    }
    for (const entryPath of entriesMap.keys()) {
      directories.delete(entryPath);
    }
    const mergedManifest: WorkerWorkspaceManifest = {
      version: 1,
      baseCommit: base.baseCommit,
      entries: [...entriesMap.values()].toSorted((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      ),
      directories: [...directories].toSorted(),
      buildCacheInputs: base.buildCacheInputs,
    };
    const raw = serializeWorkerWorkspaceManifest(mergedManifest, "stored");
    const ref = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    await params.replaceBaseline(raw, ref, patch);
  } else if (
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

export async function commitProjectionReconciliation(params: {
  conflictPaths: string[];
  resolvedCanonicalPaths?: string[];
  resolvedManifest?: WorkerWorkspaceManifest;
  resolvedManifestRef?: string;
  checkpoint?: LocalWorkspaceCheckpointRecord;
  snapshot: Parameters<typeof commitLocalWorkspaceReconciliation>[0]["snapshot"];
  refresh?: boolean;
  target: Direction;
  owner: LocalWorkspaceOwner;
  current: () => LocalWorkspaceProjection;
  selected: LocalWorkspaceProjection;
  assertCurrent?: () => void;
  update: (
    patch: Record<string, unknown>,
    checkpoint?: LocalWorkspaceManifestCheckpoint,
  ) => Promise<void>;
  replaceBaseline: (raw: string, ref: string, patch: Record<string, unknown>) => Promise<void>;
  baselineDocument?: () => Promise<{ rawManifest: string; manifestRef: string }>;
}): Promise<void> {
  try {
    await commitLocalWorkspaceReconciliation({
      ...params,
      worktreePath: params.owner.worktree.path,
      projectionPath: params.current().projection_path,
      baselineRef: params.selected.baseline_ref,
    });
  } catch (error) {
    throw new AcceptedWorkspacePublicationIndeterminateError("commit", error);
  }
}
