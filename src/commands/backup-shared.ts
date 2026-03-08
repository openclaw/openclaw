import path from "node:path";
import {
  readBestEffortConfig,
  resolveConfigPath,
  resolveOAuthDir,
  resolveStateDir,
} from "../config/config.js";
import { formatSessionArchiveTimestamp } from "../config/sessions/artifacts.js";
import { pathExists, shortenHomePath } from "../utils.js";
import { buildCleanupPlan, isPathWithin } from "./cleanup-utils.js";

export type BackupAssetKind = "state" | "config" | "credentials" | "workspace";
export type BackupSkipReason = "covered" | "missing";

export type BackupAsset = {
  kind: BackupAssetKind;
  sourcePath: string;
  displayPath: string;
  archivePath: string;
};

export type SkippedBackupAsset = {
  kind: BackupAssetKind;
  sourcePath: string;
  displayPath: string;
  reason: BackupSkipReason;
  coveredBy?: string;
};

export type BackupPlan = {
  stateDir: string;
  configPath: string;
  oauthDir: string;
  workspaceDirs: string[];
  included: BackupAsset[];
  skipped: SkippedBackupAsset[];
};

type BackupAssetCandidate = {
  kind: BackupAssetKind;
  sourcePath: string;
};

function backupAssetPriority(kind: BackupAssetKind): number {
  switch (kind) {
    case "state":
      return 0;
    case "config":
      return 1;
    case "credentials":
      return 2;
    case "workspace":
      return 3;
  }
}

export function buildBackupArchiveRoot(nowMs = Date.now()): string {
  return `openclaw-backup-${formatSessionArchiveTimestamp(nowMs)}`;
}

export function buildBackupArchiveBasename(nowMs = Date.now()): string {
  return `${buildBackupArchiveRoot(nowMs)}.tar.gz`;
}

export function encodeAbsolutePathForBackupArchive(sourcePath: string): string {
  const normalized = sourcePath.replaceAll("\\", "/");
  const windowsMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (windowsMatch) {
    const drive = windowsMatch[1]?.toUpperCase() ?? "UNKNOWN";
    const rest = windowsMatch[2] ?? "";
    return path.posix.join("windows", drive, rest);
  }
  if (normalized.startsWith("/")) {
    return path.posix.join("posix", normalized.slice(1));
  }
  return path.posix.join("relative", normalized);
}

export function buildBackupArchivePath(archiveRoot: string, sourcePath: string): string {
  return path.posix.join(archiveRoot, "payload", encodeAbsolutePathForBackupArchive(sourcePath));
}

function compareCandidates(left: BackupAssetCandidate, right: BackupAssetCandidate): number {
  const depthDelta = left.sourcePath.length - right.sourcePath.length;
  if (depthDelta !== 0) {
    return depthDelta;
  }
  const priorityDelta = backupAssetPriority(left.kind) - backupAssetPriority(right.kind);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return left.sourcePath.localeCompare(right.sourcePath);
}

export async function resolveBackupPlanFromDisk(
  params: {
    includeWorkspace?: boolean;
    nowMs?: number;
  } = {},
): Promise<BackupPlan> {
  const cfg = await readBestEffortConfig();
  const stateDir = resolveStateDir();
  const configPath = resolveConfigPath();
  const oauthDir = resolveOAuthDir();
  const cleanupPlan = buildCleanupPlan({ cfg, stateDir, configPath, oauthDir });

  const candidates: BackupAssetCandidate[] = [
    { kind: "state", sourcePath: path.resolve(stateDir) },
    ...(cleanupPlan.configInsideState
      ? []
      : [{ kind: "config" as const, sourcePath: path.resolve(configPath) }]),
    ...(cleanupPlan.oauthInsideState
      ? []
      : [{ kind: "credentials" as const, sourcePath: path.resolve(oauthDir) }]),
    ...((params.includeWorkspace ?? true)
      ? cleanupPlan.workspaceDirs.map((workspaceDir) => ({
          kind: "workspace" as const,
          sourcePath: path.resolve(workspaceDir),
        }))
      : []),
  ];

  const uniqueCandidates = [
    ...new Map(candidates.map((candidate) => [candidate.sourcePath, candidate])).values(),
  ].sort(compareCandidates);
  const archiveRoot = buildBackupArchiveRoot(params.nowMs);

  const included: BackupAsset[] = [];
  const skipped: SkippedBackupAsset[] = [];

  for (const candidate of uniqueCandidates) {
    if (!(await pathExists(candidate.sourcePath))) {
      skipped.push({
        kind: candidate.kind,
        sourcePath: candidate.sourcePath,
        displayPath: shortenHomePath(candidate.sourcePath),
        reason: "missing",
      });
      continue;
    }

    const coveredBy = included.find((asset) =>
      isPathWithin(candidate.sourcePath, asset.sourcePath),
    );
    if (coveredBy) {
      skipped.push({
        kind: candidate.kind,
        sourcePath: candidate.sourcePath,
        displayPath: shortenHomePath(candidate.sourcePath),
        reason: "covered",
        coveredBy: coveredBy.displayPath,
      });
      continue;
    }

    included.push({
      kind: candidate.kind,
      sourcePath: candidate.sourcePath,
      displayPath: shortenHomePath(candidate.sourcePath),
      archivePath: buildBackupArchivePath(archiveRoot, candidate.sourcePath),
    });
  }

  return {
    stateDir,
    configPath,
    oauthDir,
    workspaceDirs: cleanupPlan.workspaceDirs.map((entry) => path.resolve(entry)),
    included,
    skipped,
  };
}
