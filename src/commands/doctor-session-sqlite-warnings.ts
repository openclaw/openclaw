import { formatCliCommand } from "../cli/command-format.js";
import { isSessionSqliteMigrationWarning } from "../infra/session-sqlite-migration-issues.js";
import {
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import type { DoctorSessionSqliteTargetReport } from "./doctor-session-sqlite-types.js";

const HISTORICAL_WARNING_EXAMPLES = 5;

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
        ++historicalCount > HISTORICAL_WARNING_EXAMPLES
      ) {
        return [];
      }
      return [`${target.storePath}: [${issue.code}] ${issue.message}`];
    });
    if (historicalCount > HISTORICAL_WARNING_EXAMPLES) {
      warnings.unshift(
        `${target.storePath}: Deferred ${historicalCount} historical transcript claim(s); ` +
          `showing ${HISTORICAL_WARNING_EXAMPLES} example(s), ${historicalCount - HISTORICAL_WARNING_EXAMPLES} omitted. ` +
          "Available originals and migration manifests remain protected. " +
          `Inspect all findings with "${formatCliCommand("openclaw doctor --session-sqlite dry-run --session-sqlite-all-agents --json", env)}".`,
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
