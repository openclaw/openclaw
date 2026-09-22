import {
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
} from "./doctor-session-sqlite-migration-run.js";
import {
  isSessionSqliteMigrationWarning,
  type DoctorSessionSqliteTargetReport,
} from "./doctor-session-sqlite-types.js";

export function formatSessionSqliteMigrationWarnings(
  targets: readonly Pick<DoctorSessionSqliteTargetReport, "storePath" | "issues">[],
): string[] {
  return targets.flatMap((target) =>
    target.issues
      .filter(isSessionSqliteMigrationWarning)
      .map((issue) => `${target.storePath}: [${issue.code}] ${issue.message}`),
  );
}

/** Published updaters may predate the warning result channel; Doctor owns this durable report. */
export function readSessionSqliteMigrationWarnings(env = process.env): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const manifestPath of listSessionSqliteMigrationManifestPaths(env)) {
    const manifest = readSessionSqliteMigrationManifest(manifestPath);
    // Starting a retry does not clear the previous completed import's warnings.
    if (!manifest?.completedAt) {
      continue;
    }
    for (const target of manifest.targets) {
      const key = JSON.stringify([target.agentId, target.storePath, target.sqlitePath]);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      warnings.push(...formatSessionSqliteMigrationWarnings([target]));
    }
  }
  return warnings;
}
