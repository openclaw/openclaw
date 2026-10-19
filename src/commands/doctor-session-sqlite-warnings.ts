import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveRealpathOrAbsolute } from "../infra/boundary-path.js";
import {
  formatMigrationWarningSummary,
  MIGRATION_WARNING_EXAMPLE_LIMIT,
} from "../infra/migration-warning-summary.js";
import {
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
  type SessionSqliteMigrationTargetManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DoctorSessionSqliteTargetReport } from "./doctor-session-sqlite-types.js";

export function formatSessionSqliteMigrationWarnings(
  targets: readonly Pick<DoctorSessionSqliteTargetReport, "storePath" | "issues">[],
  env = process.env,
): string[] {
  return targets.flatMap((target) => {
    let historicalCount = 0;
    // Bound presentation only: raw reports and recovery receipts keep every claim.
    const warnings = target.issues.flatMap((issue) => {
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

function isResolvedActiveTranscriptWarning(
  issue: SessionSqliteMigrationTargetManifest["issues"][number],
  sessionsDir: string,
): boolean {
  if (issue.code !== "active_sqlite_transcript_jsonl") {
    return false;
  }
  // Older manifests store the path only in the diagnostic text. Unknown formats
  // cannot establish resolution and must retain their recovery guidance.
  const transcriptPath = issue.message.match(
    /^SQLite-backed session has a legacy JSONL transcript awaiting verification: (.+\.jsonl)\. Run openclaw doctor /s,
  )?.[1];
  if (!transcriptPath || !path.isAbsolute(transcriptPath) || transcriptPath.includes("\0")) {
    return false;
  }
  if (path.dirname(resolveRealpathOrAbsolute(transcriptPath)) !== sessionsDir) {
    return true;
  }
  try {
    fs.statSync(transcriptPath);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

function currentMigrationIssues(
  target: SessionSqliteMigrationTargetManifest,
  env: NodeJS.ProcessEnv,
) {
  if (!target.issues.some((issue) => issue.code === "active_sqlite_transcript_jsonl")) {
    return target.issues;
  }
  try {
    // A missing database is not a clean scan. The read owner admits an existing
    // schema without creating, migrating, or registering the live store.
    const read = withOpenClawAgentDatabaseReadOnly(
      () => {
        const sessionsDir = resolveRealpathOrAbsolute(path.dirname(target.storePath));
        return target.issues.filter(
          (issue) => !isResolvedActiveTranscriptWarning(issue, sessionsDir),
        );
      },
      { agentId: target.agentId, path: target.sqlitePath, env },
    );
    return read.found ? read.value : target.issues;
  } catch {
    return target.issues;
  }
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
      warnings.push(
        ...formatSessionSqliteMigrationWarnings(
          [{ ...target, issues: currentMigrationIssues(target, env) }],
          env,
        ),
      );
    }
  }
  return warnings;
}
