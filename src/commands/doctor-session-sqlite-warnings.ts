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
  const findings: HealthFinding[] = [];
  const historicalExamples: { storePath: string; message: string }[] = [];
  const historicalPaths = new Set<string>();
  let historicalCount = 0;
  const docsUrl = "https://docs.openclaw.ai/cli/doctor/sqlite-maintenance#session-sqlite-migration";
  for (const target of targets) {
    const current: DoctorSessionSqliteTargetReport["issues"][number][] = [];
    for (const issue of target.issues) {
      if (isHistoricalSessionSqliteMigrationIssue(issue)) {
        historicalCount++;
        historicalPaths.add(target.storePath);
        if (historicalExamples.length < MIGRATION_WARNING_EXAMPLE_LIMIT) {
          historicalExamples.push({ storePath: target.storePath, message: issue.message });
        }
      } else {
        current.push(issue);
      }
    }
    const common = {
      checkId: "core/doctor/session-transcripts",
      severity: "warning" as const,
      category: "fix-now" as const,
      path: target.storePath,
      fixHint: `Inspect with "${inspect}" before attempting recovery.`,
      docsUrl,
    };
    for (const issue of current) {
      findings.push({ ...common, errorCode: issue.code, message: issue.message });
    }
  }
  if (historicalCount > 0) {
    const summary =
      historicalCount > MIGRATION_WARNING_EXAMPLE_LIMIT
        ? formatMigrationWarningSummary({
            summary: `${historicalCount} historical recovery notice(s)`,
            count: historicalCount,
            detail: "Recovery evidence remains retained.",
          })
        : `${historicalCount} historical recovery notice(s). Recovery evidence remains retained.`;
    findings.push({
      checkId: "core/doctor/session-transcripts",
      severity: "warning",
      category: "historical",
      ...(historicalPaths.size === 1 ? { path: [...historicalPaths][0] } : {}),
      message: [
        summary,
        ...historicalExamples.map(({ storePath, message }) =>
          historicalPaths.size > 1 ? `  - ${storePath}: ${message}` : `  - ${message}`,
        ),
      ].join("\n"),
      fixHint: `No action needed if expected conversations are visible. Keep recovery archives. If a conversation is missing, inspect with "${inspect}".`,
      docsUrl,
    });
  }
  return findings;
}
