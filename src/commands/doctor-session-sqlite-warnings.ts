import { formatCliCommand } from "../cli/command-format.js";
import {
  formatMigrationWarningSummary,
  MIGRATION_WARNING_EXAMPLE_LIMIT,
} from "../infra/migration-warning-summary.js";
import { isSessionSqliteMigrationWarning } from "../infra/session-sqlite-migration-issues.js";
import {
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import type { DoctorSessionSqliteTargetReport } from "./doctor-session-sqlite-types.js";

export function formatSessionSqliteMigrationWarnings(
  targets: readonly Pick<DoctorSessionSqliteTargetReport, "storePath" | "issues">[],
  env = process.env,
): string[] {
  return targets.flatMap((target) => {
    let historicalCount = 0;
    // Bound presentation only: raw reports and recovery receipts keep every claim.
    const warnings = target.issues.filter(isSessionSqliteMigrationWarning).flatMap((issue) => {
      if (
        issue.code === "historical_transcript_deferred" &&
        ++historicalCount > MIGRATION_WARNING_EXAMPLE_LIMIT
      ) {
        return [];
      }
      return [`${target.storePath}: [${issue.code}] ${issue.message}`];
    });
    if (historicalCount > MIGRATION_WARNING_EXAMPLE_LIMIT) {
      warnings.unshift(
        formatMigrationWarningSummary({
          summary: `${target.storePath}: Deferred ${historicalCount} historical transcript claim(s)`,
          count: historicalCount,
          detail:
            "Available originals and migration manifests remain protected. " +
            `Inspect all findings with "${formatCliCommand("openclaw doctor --session-sqlite dry-run --session-sqlite-all-agents --json", env)}".`,
        }),
      );
    }
    return warnings;
  });
}

/** Blocking findings are what stop archive. The warning list above does not include them. */
export function formatSessionSqliteMigrationBlockingIssues(
  targets: readonly Pick<DoctorSessionSqliteTargetReport, "storePath" | "issues">[],
  env = process.env,
): string[] {
  return targets.flatMap((target) => {
    const blocking = target.issues.filter((issue) => !isSessionSqliteMigrationWarning(issue));
    const lines = blocking
      .slice(0, MIGRATION_WARNING_EXAMPLE_LIMIT)
      .map((issue) => `${target.storePath}: [${issue.code}] ${issue.message}`);
    if (blocking.length > MIGRATION_WARNING_EXAMPLE_LIMIT) {
      lines.unshift(
        formatMigrationWarningSummary({
          summary: `${target.storePath}: ${blocking.length} blocking session SQLite issue(s)`,
          count: blocking.length,
          detail:
            "These issues prevent archive of this legacy store. " +
            `Inspect all findings with "${formatCliCommand("openclaw doctor --session-sqlite dry-run --session-sqlite-all-agents --json", env)}".`,
        }),
      );
    }
    return lines;
  });
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
      warnings.push(...formatSessionSqliteMigrationWarnings([target], env));
    }
  }
  return warnings;
}
