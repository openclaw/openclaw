import path from "node:path";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import {
  isArchivePathWithin,
  normalizeArchivePath,
  normalizeArchiveRoot,
  type BackupSymbolicLink,
} from "../infra/backup-archive-path-policy.js";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import { isRecord } from "../utils.js";
import { buildBackupArchivePath } from "./backup-shared.js";

export function backupManifestSizeError(bytes: number): Error | undefined {
  const maxBytes = 1024 * 1024;
  return bytes > maxBytes
    ? new Error(`Backup manifest exceeds ${maxBytes} byte limit.`)
    : undefined;
}

type BackupManifestSqliteSnapshot = { sourcePath: string } & (
  | { role: "global" }
  | { role: "agent"; agentId: string }
);

export type BackupManifest = {
  schemaVersion: number;
  createdAt: string;
  archiveRoot: string;
  runtimeVersion: string;
  platform: string;
  nodeVersion: string;
  options?: {
    includeWorkspace?: boolean;
    onlyConfig?: boolean;
  };
  paths?: {
    stateDir?: string;
    configPath?: string;
    oauthDir?: string;
    workspaceDirs?: string[];
    agentRoots?: Array<{ agentId: string; sourcePath: string }>;
  };
  assets: Array<{
    kind: string;
    sourcePath: string;
    archivePath: string;
  }>;
  /** Capture-time canonical database inventory; absent in legacy archives. */
  sqliteSnapshots?: BackupManifestSqliteSnapshot[];
  externalSymbolicLinks?: BackupSymbolicLink[];
  skipped?: Array<{
    kind?: string;
    sourcePath?: string;
    reason?: string;
    coveredBy?: string;
  }>;
};

function parseBackupManifestSourcePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`Backup manifest ${label} has an invalid sourcePath.`);
  }
  const windowsPath = /^(?:[A-Za-z]:[\\/]|\\\\(?![?.]\\))/u.test(value);
  const normalized = windowsPath ? path.win32.normalize(value) : path.posix.normalize(value);
  if ((!windowsPath && !value.startsWith("/")) || normalized !== value) {
    throw new Error(`Backup manifest ${label} sourcePath must be absolute and normalized.`);
  }
  return value;
}

function parseBackupManifestAgentRoots(
  value: unknown,
): Array<{ agentId: string; sourcePath: string }> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Backup manifest agentRoots must be an array.");
  }

  const agentRoots: Array<{ agentId: string; sourcePath: string }> = [];
  const seenAgentIds = new Set<string>();
  const seenSourcePaths = new Set<string>();
  for (const agentRoot of value) {
    if (
      !isRecord(agentRoot) ||
      Object.keys(agentRoot).length !== 2 ||
      !Object.hasOwn(agentRoot, "agentId") ||
      !Object.hasOwn(agentRoot, "sourcePath")
    ) {
      throw new Error("Backup manifest agent root must contain only agentId and sourcePath.");
    }
    const { agentId, sourcePath } = agentRoot;
    if (typeof agentId !== "string" || !agentId || normalizeAgentId(agentId) !== agentId) {
      throw new Error("Backup manifest agent root has an invalid or noncanonical agentId.");
    }
    const normalizedSourcePath = parseBackupManifestSourcePath(sourcePath, "agent root");
    const windowsPath = /^(?:[A-Za-z]:[\\/]|\\\\(?![?.]\\))/u.test(normalizedSourcePath);
    const sourcePathKey = windowsPath
      ? normalizeWindowsPathForComparison(normalizedSourcePath)
      : normalizedSourcePath;
    if (seenAgentIds.has(agentId) || seenSourcePaths.has(sourcePathKey)) {
      throw new Error("Backup manifest contains duplicate agent root ownership.");
    }
    seenAgentIds.add(agentId);
    seenSourcePaths.add(sourcePathKey);
    agentRoots.push({ agentId, sourcePath: normalizedSourcePath });
  }
  return agentRoots;
}

function parseBackupManifestSqliteSnapshots(
  value: unknown,
): BackupManifestSqliteSnapshot[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Backup manifest sqliteSnapshots must be an array.");
  }
  const owners = new Set<string>();
  const paths = new Set<string>();
  return value.map((snapshot) => {
    if (
      !isRecord(snapshot) ||
      (snapshot.role !== "global" && snapshot.role !== "agent") ||
      Object.keys(snapshot).some(
        (key) =>
          key !== "sourcePath" &&
          key !== "role" &&
          !(snapshot.role === "agent" && key === "agentId"),
      )
    ) {
      throw new Error("Backup manifest contains an invalid SQLite snapshot owner.");
    }
    const sourcePath = parseBackupManifestSourcePath(snapshot.sourcePath, "SQLite snapshot");
    let identity: { role: "global" } | { role: "agent"; agentId: string };
    if (snapshot.role === "global") {
      identity = { role: "global" };
    } else {
      const agentId = snapshot.agentId;
      if (typeof agentId !== "string" || !agentId || normalizeAgentId(agentId) !== agentId) {
        throw new Error("Backup manifest SQLite snapshot has an invalid agentId.");
      }
      identity = { role: "agent", agentId };
    }
    const owner = identity.role === "global" ? "global" : `agent:${identity.agentId}`;
    // Archives must restore portably, even when created on a case-sensitive host.
    const sourceKey = sourcePath.replaceAll("\\", "/").normalize("NFC").toLowerCase();
    if (owners.has(owner) || paths.has(sourceKey)) {
      throw new Error("Backup manifest contains duplicate SQLite snapshot ownership.");
    }
    owners.add(owner);
    paths.add(sourceKey);
    return { sourcePath, ...identity };
  });
}

export function parseBackupManifest(raw: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("Backup manifest is not valid JSON.", { cause: err });
  }

  if (!isRecord(parsed)) {
    throw new Error("Backup manifest must be an object.");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported backup manifest schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  if (typeof parsed.archiveRoot !== "string" || !parsed.archiveRoot.trim()) {
    throw new Error("Backup manifest is missing archiveRoot.");
  }
  if (typeof parsed.createdAt !== "string" || !parsed.createdAt.trim()) {
    throw new Error("Backup manifest is missing createdAt.");
  }
  if (!Array.isArray(parsed.assets)) {
    throw new Error("Backup manifest is missing assets.");
  }

  const assets: BackupManifest["assets"] = [];
  for (const asset of parsed.assets) {
    if (!isRecord(asset)) {
      throw new Error("Backup manifest contains a non-object asset.");
    }
    if (typeof asset.kind !== "string" || !asset.kind.trim()) {
      throw new Error("Backup manifest asset is missing kind.");
    }
    if (typeof asset.sourcePath !== "string" || !asset.sourcePath.trim()) {
      throw new Error("Backup manifest asset is missing sourcePath.");
    }
    if (typeof asset.archivePath !== "string" || !asset.archivePath.trim()) {
      throw new Error("Backup manifest asset is missing archivePath.");
    }
    assets.push({
      kind: asset.kind,
      sourcePath: asset.sourcePath,
      archivePath: asset.archivePath,
    });
  }

  const externalSymbolicLinks: BackupSymbolicLink[] = [];
  if (parsed.externalSymbolicLinks !== undefined) {
    if (!Array.isArray(parsed.externalSymbolicLinks)) {
      throw new Error("Backup manifest externalSymbolicLinks must be an array.");
    }
    for (const link of parsed.externalSymbolicLinks) {
      if (
        !isRecord(link) ||
        typeof link.entryPath !== "string" ||
        typeof link.linkpath !== "string"
      ) {
        throw new Error("Backup manifest contains an invalid external symbolic link.");
      }
      externalSymbolicLinks.push({ entryPath: link.entryPath, linkpath: link.linkpath });
    }
  }

  return {
    schemaVersion: 1,
    archiveRoot: parsed.archiveRoot,
    createdAt: parsed.createdAt,
    runtimeVersion:
      typeof parsed.runtimeVersion === "string" && parsed.runtimeVersion.trim()
        ? parsed.runtimeVersion
        : "unknown",
    platform: typeof parsed.platform === "string" ? parsed.platform : "unknown",
    nodeVersion: typeof parsed.nodeVersion === "string" ? parsed.nodeVersion : "unknown",
    paths: isRecord(parsed.paths)
      ? {
          ...(parsed.paths.stateDir === undefined
            ? {}
            : {
                stateDir: parseBackupManifestSourcePath(parsed.paths.stateDir, "state directory"),
              }),
          agentRoots: parseBackupManifestAgentRoots(parsed.paths.agentRoots),
        }
      : undefined,
    assets,
    sqliteSnapshots: parseBackupManifestSqliteSnapshots(parsed.sqliteSnapshots),
    ...(parsed.externalSymbolicLinks === undefined ? {} : { externalSymbolicLinks }),
  };
}

export function isRootBackupManifestEntry(entryPath: string): boolean {
  const parts = entryPath.split("/");
  return parts.length === 2 && parts[0] !== "" && parts[1] === "manifest.json";
}

export function verifyBackupManifestEntries(manifest: BackupManifest, entries: Set<string>): void {
  const archiveRoot = normalizeArchiveRoot(manifest.archiveRoot);
  const manifestEntryPath = path.posix.join(archiveRoot, "manifest.json");
  const normalizedEntries = [...entries];

  if (!entries.has(manifestEntryPath)) {
    throw new Error(`Archive is missing manifest entry: ${manifestEntryPath}`);
  }

  for (const entry of normalizedEntries) {
    if (!isArchivePathWithin(entry, archiveRoot)) {
      throw new Error(`Archive entry is outside the declared archive root: ${entry}`);
    }
  }

  const payloadRoot = path.posix.join(archiveRoot, "payload");
  for (const asset of manifest.assets) {
    const assetArchivePath = normalizeArchivePath(asset.archivePath, "Backup manifest asset path");
    if (!isArchivePathWithin(assetArchivePath, payloadRoot)) {
      throw new Error(`Manifest asset path is outside payload root: ${asset.archivePath}`);
    }
    if (
      !entries.has(assetArchivePath) &&
      !normalizedEntries.some((entry) => isArchivePathWithin(entry, assetArchivePath))
    ) {
      throw new Error(`Archive is missing payload for manifest asset: ${assetArchivePath}`);
    }
  }
}

/** The capture-time inventory, never today's filesystem, defines required database coverage. */
export function verifyBackupSqliteCoverage(
  manifest: BackupManifest,
  requiredSnapshots: readonly BackupManifestSqliteSnapshot[],
  verifiedSnapshots: readonly ({ archivePath: string } & (
    | { role: "global" }
    | { role: "agent"; agentId: string }
  ))[],
): void {
  for (const required of [...(manifest.sqliteSnapshots ?? []), ...requiredSnapshots]) {
    const expectedPath = buildBackupArchivePath(manifest.archiveRoot, required.sourcePath);
    if (
      !verifiedSnapshots.some(
        (verified) =>
          verified.archivePath === expectedPath &&
          verified.role === required.role &&
          (required.role === "global" ||
            (verified.role === "agent" && verified.agentId === required.agentId)),
      )
    ) {
      throw new Error(
        `Backup lacks verified canonical SQLite coverage for ${required.sourcePath}.`,
      );
    }
  }
}
