import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "@openclaw/fs-safe/path";
import type { BackupResourcePlan } from "../commands/backup-resource-inventory.js";
import type { BackupAsset } from "../commands/backup-shared.js";
import { resolveGatewayLockDir } from "../config/paths.js";
import {
  buildBackupArchivePath,
  resolvePortableArchivePathKey,
} from "./backup-archive-path-policy.js";
import { isLegacyAuditMigrationBackupPath } from "./backup-audit-paths.js";
import { isExcludedBackupSqliteSourceName } from "./backup-sqlite-classified-path.js";
import { ignoreMissingPath } from "./errno.js";
import { isUpdateCapturePath } from "./update-capture-paths.js";

export type BackupPortablePathCollision = { first: string; second: string };

type EntryKind = "directory" | "symlink" | "file" | "other";

function direntKind(entry: Dirent): EntryKind | undefined {
  if (entry.isDirectory()) {
    return "directory";
  }
  if (entry.isSymbolicLink()) {
    return "symlink";
  }
  if (entry.isFile()) {
    return "file";
  }
  // Some filesystems do not report entry types from readdir.
  return entry.isBlockDevice() || entry.isCharacterDevice() || entry.isFIFO() || entry.isSocket()
    ? "other"
    : undefined;
}

async function lstatKind(sourcePath: string): Promise<EntryKind | undefined> {
  const stat = await fs.lstat(sourcePath).catch(ignoreMissingPath);
  if (!stat) {
    return undefined;
  }
  return stat.isDirectory()
    ? "directory"
    : stat.isSymbolicLink()
      ? "symlink"
      : stat.isFile()
        ? "file"
        : "other";
}

/**
 * Find source paths the archive verifier would reject as portable path collisions,
 * using names only so the check runs before snapshots, reads, or compression.
 */
async function findBackupSourcePortablePathCollision(params: {
  archiveRoot: string;
  sourcePaths: readonly string[];
  signal?: AbortSignal;
  skip: (sourcePath: string, root: boolean) => boolean;
  include: (sourcePath: string, kind: "directory" | "symlink" | "file") => boolean;
}): Promise<BackupPortablePathCollision | undefined> {
  const seen = new Map<string, { sourcePath: string; archivePath: string }>();
  const record = (sourcePath: string): BackupPortablePathCollision | undefined => {
    const archivePath = buildBackupArchivePath(params.archiveRoot, sourcePath);
    const key = resolvePortableArchivePathKey(archivePath);
    const first = seen.get(key);
    if (first && first.archivePath !== archivePath) {
      return { first: first.sourcePath, second: sourcePath };
    }
    seen.set(key, { sourcePath, archivePath });
    return undefined;
  };
  const pending: Array<{ sourcePath: string; kind?: EntryKind; root: boolean }> = params.sourcePaths
    .map((sourcePath) => ({ sourcePath, root: true }))
    .toReversed();
  while (pending.length) {
    params.signal?.throwIfAborted();
    const next = pending.pop();
    if (!next || params.skip(next.sourcePath, next.root)) {
      continue;
    }
    const kind = next.kind ?? (await lstatKind(next.sourcePath));
    if (!kind || kind === "other" || !params.include(next.sourcePath, kind)) {
      continue;
    }
    const collision = record(next.sourcePath);
    if (collision) {
      return collision;
    }
    if (kind !== "directory") {
      continue;
    }
    const entries = await fs
      .readdir(next.sourcePath, { withFileTypes: true })
      .catch(ignoreMissingPath);
    for (const entry of (entries ?? []).toReversed()) {
      pending.push({
        sourcePath: path.join(next.sourcePath, entry.name),
        kind: direntKind(entry),
        root: false,
      });
    }
  }
  return undefined;
}

// Verification rejects case- or normalization-only path collisions; find them
// before database capture and compression rather than after a full archive write.
export async function assertNoPortableSourcePathCollision(
  plan: { resources: BackupResourcePlan; stateDir: string; workspaceDirs: readonly string[] },
  archiveRoot: string,
  assets: readonly BackupAsset[],
  signal?: AbortSignal,
): Promise<void> {
  const stateAsset = assets.find((asset) => asset.kind === "state");
  const gatewayLockDir = resolveGatewayLockDir(plan.stateDir);
  // Mirrors the archive filter: the resource plan owns privacy admission unless
  // a linked state root has a distinct configured capture sibling.
  const checkConfiguredCaptureRoot = plan.stateDir !== plan.resources.stateDir;
  const collision = await findBackupSourcePortablePathCollision({
    archiveRoot,
    sourcePaths: [...new Set(assets.map((asset) => asset.sourcePath))],
    signal,
    skip: (sourcePath, root) => !root && plan.resources.isVolatile(sourcePath),
    include: (sourcePath, kind) => {
      const resolved = path.resolve(sourcePath);
      return (
        !(checkConfiguredCaptureRoot && isUpdateCapturePath(resolved, plan.stateDir)) &&
        (kind === "file"
          ? plan.resources.isIncluded(resolved)
          : plan.resources.isTraversable(resolved)) &&
        !isPathInside(gatewayLockDir, resolved) &&
        !(stateAsset && isLegacyAuditMigrationBackupPath(resolved, stateAsset.sourcePath)) &&
        !isExcludedBackupSqliteSourceName(resolved, plan.resources)
      );
    },
  });
  if (!collision) {
    return;
  }
  const inWorkspace = (sourcePath: string) =>
    plan.workspaceDirs.some((workspaceDir) => isPathInside(workspaceDir, sourcePath));
  const workspaceHint =
    inWorkspace(collision.first) && inWorkspace(collision.second)
      ? " or pass --no-include-workspace"
      : "";
  throw new Error(
    `Backup sources contain paths that differ only by letter case or Unicode normalization and cannot be restored portably: ${collision.first} and ${collision.second}. Rename or move one of them${workspaceHint}, then retry. No archive was written.`,
  );
}
