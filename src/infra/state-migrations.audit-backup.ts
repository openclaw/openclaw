// Builds secret-sanitized backup replacements for legacy audit append archives.
import fs from "node:fs/promises";
import path from "node:path";
import { root as createFsSafeRoot } from "./fs-safe.js";
import { detectLegacyAuditLogs } from "./state-migrations.audit-checkpoints.js";
import { prepareLegacyAuditRecords } from "./state-migrations.audit-logs.js";
import {
  readLegacyAuditRecoverySourceForBackup,
  readLegacyAuditSourcePrefixSnapshotForBackup,
} from "./state-migrations.audit-recovery.js";

const LEGACY_AUDIT_LOGICAL_PATHS = [
  { directory: "logs", basename: "config-audit.jsonl" },
  { directory: "audit", basename: "system-agent.jsonl" },
  { directory: "audit", basename: "crestodian.jsonl" },
] as const;

export async function hasLegacyAuditBackupSources(stateDir: string): Promise<boolean> {
  for (const logical of LEGACY_AUDIT_LOGICAL_PATHS) {
    let entries: string[];
    try {
      entries = await fs.readdir(path.join(stateDir, logical.directory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const escaped = logical.basename.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const sourcePattern = new RegExp(
      `^(?:${escaped}|\\.${escaped}\\.doctor-importing(?:\\.(?:[2-9]|[1-9][0-9]+))?|${escaped}\\.migrated(?:\\.(?:[2-9]|[1-9][0-9]+))?\\.raw(?:\\.doctor-scrub-(?:progress|restore|staging))?)$`,
      "u",
    );
    if (entries.some((entry) => sourcePattern.test(entry))) {
      return true;
    }
  }
  return false;
}

export function isLegacyAuditMigrationBackupPath(sourcePath: string, stateDir: string): boolean {
  const relativePath = path.relative(path.resolve(stateDir), path.resolve(sourcePath));
  if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return false;
  }
  const directory = path.dirname(relativePath);
  const basename = path.basename(relativePath);
  for (const logical of LEGACY_AUDIT_LOGICAL_PATHS) {
    if (directory !== logical.directory) {
      continue;
    }
    if (basename === logical.basename) {
      return true;
    }
    const escaped = logical.basename.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const claimPattern = new RegExp(
      `^\\.${escaped}\\.doctor-importing(?:\\.(?:[2-9]|[1-9][0-9]+))?$`,
      "u",
    );
    const rawPattern = new RegExp(
      `^${escaped}\\.migrated(?:\\.(?:[2-9]|[1-9][0-9]+))?\\.raw(?:\\.doctor-scrub-(?:progress|restore|staging))?$`,
      "u",
    );
    if (claimPattern.test(basename) || rawPattern.test(basename)) {
      return true;
    }
  }
  return false;
}

export type LegacyAuditBackupSnapshot = {
  sourcePath: string;
  archiveSourcePath: string;
  skippedSourcePaths: Set<string>;
};

async function createLegacyAuditBackupSnapshotsOnce(params: {
  stateDir: string;
  tempDir: string;
}): Promise<LegacyAuditBackupSnapshot[]> {
  const detected = detectLegacyAuditLogs({
    stateDir: params.stateDir,
    doctorOnlyStateMigrations: true,
  });
  if (detected.sources.length === 0) {
    return [];
  }
  const root = await createFsSafeRoot(params.stateDir, {
    hardlinks: "reject",
    maxBytes: Number.MAX_SAFE_INTEGER,
    mkdir: false,
    mode: 0o600,
    symlinks: "reject",
  });
  const snapshots: LegacyAuditBackupSnapshot[] = [];
  for (const [index, source] of detected.sources.entries()) {
    const sourceRelativePath = path.relative(path.resolve(params.stateDir), source.sourcePath);
    const snapshot =
      source.storage === "raw-archive"
        ? await readLegacyAuditRecoverySourceForBackup(root, sourceRelativePath)
        : await readLegacyAuditSourcePrefixSnapshotForBackup(root, sourceRelativePath);
    const prepared = prepareLegacyAuditRecords(source, snapshot.raw, `backup-${index}`);
    if (!prepared.ok) {
      throw new Error(
        `Legacy ${source.label} append archive cannot be sanitized for backup: ${prepared.warnings.join("; ")}`,
      );
    }
    const sourcePath = path.join(params.tempDir, `legacy-audit-raw-${index}.jsonl`);
    await fs.writeFile(sourcePath, prepared.sanitizedJsonl, { mode: 0o600 });
    snapshots.push({
      sourcePath,
      archiveSourcePath: source.sourcePath,
      skippedSourcePaths: new Set([
        path.resolve(source.sourcePath),
        path.resolve(`${source.sourcePath}.doctor-scrub-progress`),
        path.resolve(`${source.sourcePath}.doctor-scrub-restore`),
        path.resolve(`${source.sourcePath}.doctor-scrub-staging`),
      ]),
    });
  }
  return snapshots;
}

export async function createLegacyAuditBackupSnapshots(params: {
  stateDir: string;
  tempDir: string;
}): Promise<LegacyAuditBackupSnapshot[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await createLegacyAuditBackupSnapshotsOnce(params);
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
      }
    }
  }
  throw lastError;
}
