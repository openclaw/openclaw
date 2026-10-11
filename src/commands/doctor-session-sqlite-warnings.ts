import { formatCliCommand } from "../cli/command-format.js";
import type { HealthFinding } from "../flows/health-checks.js";
import {
  formatMigrationWarningSummary,
  MIGRATION_WARNING_EXAMPLE_LIMIT,
} from "../infra/migration-warning-summary.js";
import {
  isHistoricalSessionSqliteMigrationIssue,
  isSessionSqliteMigrationWarning,
} from "../infra/session-sqlite-migration-issues.js";
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

/** Bound human presentation; manifests and warning result channels retain their evidence. */
export function collectSessionSqliteMigrationFindings(
  targets: readonly Pick<DoctorSessionSqliteTargetReport, "storePath" | "issues">[],
  env = process.env,
): HealthFinding[] {
  const inspect = formatCliCommand(
    "openclaw doctor --session-sqlite dry-run --session-sqlite-all-agents --json",
    env,
  );
  return targets.flatMap((target) =>
    [false, true].flatMap((historical) => {
      const issues = target.issues.filter(
        (issue) => isHistoricalSessionSqliteMigrationIssue(issue) === historical,
      );
      const common = {
        checkId: "core/doctor/session-transcripts",
        severity: "warning" as const,
        path: target.storePath,
        category: historical ? ("historical" as const) : ("fix-now" as const),
        fixHint: historical
          ? `No action needed if expected conversations are visible. Keep recovery archives. If a conversation is missing, inspect with "${inspect}".`
          : `Inspect with "${inspect}" before attempting recovery.`,
        docsUrl: "https://docs.openclaw.ai/cli/doctor/sqlite-maintenance#session-sqlite-migration",
      };
      const findings: HealthFinding[] = issues
        .slice(0, MIGRATION_WARNING_EXAMPLE_LIMIT)
        .map((issue) => ({
          ...common,
          errorCode: issue.code,
          message: issue.message,
        }));
      if (issues.length > MIGRATION_WARNING_EXAMPLE_LIMIT) {
        findings.push({
          ...common,
          message: formatMigrationWarningSummary({
            summary: `${issues.length} ${historical ? "historical recovery notice(s)" : "current session issue(s)"}`,
            count: issues.length,
            detail: `Inspect every finding with "${inspect}". Recovery evidence remains retained.`,
          }),
        });
      }
      return findings;
    }),
  );
}
