import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { extractGeneratedTranscriptSessionId } from "../config/sessions/generated-transcript-session-id.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { readCanonicalSessionMainKey } from "../config/sessions/session-canonical-key.js";
import { normalizeStoreSessionKey } from "../config/sessions/store-entry.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  formatMigrationWarningSummary,
  MIGRATION_WARNING_EXAMPLE_LIMIT,
} from "../infra/migration-warning-summary.js";
import { isHistoricalSessionSqliteMigrationIssue } from "../infra/session-sqlite-migration-issues.js";
import {
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
  type SessionSqliteMigrationTargetManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import { countTranscriptEventsForPath } from "../infra/session-sqlite-migration-readers.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { resolveActiveSqliteTranscriptFile } from "./doctor-session-sqlite-transcript-file.js";
import type { DoctorSessionSqliteTargetReport } from "./doctor-session-sqlite-types.js";

// Old manifests stored paths in diagnostic text, not structured artifact fields.
const TRANSCRIPT_FINDINGS = new Map([
  [
    "active_sqlite_transcript_jsonl",
    /^SQLite-backed session has a legacy JSONL transcript awaiting verification: (.+)\. Run openclaw doctor /s,
  ],
  ["transcript_missing", /^Transcript file is missing: (.+)$/s],
  ["transcript_malformed", /^(.+\.jsonl): (?:SyntaxError|Error|TypeError|RangeError)\b/s],
]);

function currentMigrationIssues(
  target: SessionSqliteMigrationTargetManifest,
  env: NodeJS.ProcessEnv,
) {
  if (!target.issues.some((issue) => TRANSCRIPT_FINDINGS.has(issue.code))) {
    return target.issues;
  }
  const claims = target.issues.filter(
    (issue) =>
      issue.code !== "active_sqlite_transcript_jsonl" && TRANSCRIPT_FINDINGS.has(issue.code),
  );
  const keys = [
    ...new Set(
      claims.flatMap((issue) => (issue.sessionKey ? [issue.sessionKey.toLowerCase()] : [])),
    ),
  ];
  const ids = [
    ...new Set(
      claims.flatMap((issue) => {
        const file = TRANSCRIPT_FINDINGS.get(issue.code)?.exec(issue.message)?.[1];
        return file
          ? [extractGeneratedTranscriptSessionId(file) ?? path.basename(file, ".jsonl")]
          : [];
      }),
    ),
  ];
  try {
    const read = withOpenClawAgentDatabaseReadOnly(
      (database) => {
        const query = getSessionKysely(database.db);
        const live = new Set(
          keys.length
            ? executeSqliteQuerySync(
                database.db,
                query
                  .selectFrom("session_nodes")
                  .select("session_key")
                  .where("entry_valid", "=", 1)
                  .where(query.fn<string>("lower", ["session_key"]), "in", keys),
              ).rows.map((row) => row.session_key.toLowerCase())
            : [],
        );
        const transcripts = new Set(
          keys.length && ids.length
            ? executeSqliteQuerySync(
                database.db,
                query
                  .selectFrom("session_windows")
                  .select(["session_key", "session_id"])
                  .where(query.fn<string>("lower", ["session_key"]), "in", keys)
                  .where("session_id", "in", ids)
                  .where((eb) =>
                    eb.exists(
                      eb
                        .selectFrom("transcript_events")
                        .select("session_id")
                        .whereRef(
                          "transcript_events.session_id",
                          "=",
                          "session_windows.session_id",
                        ),
                    ),
                  ),
              ).rows.map((row) => `${row.session_key.toLowerCase()}\0${row.session_id}`)
            : [],
        );
        const mainAliases = new Set(
          keys.length ? ["main", readCanonicalSessionMainKey(database)] : [],
        );
        return target.issues.filter((issue) => {
          const pattern = TRANSCRIPT_FINDINGS.get(issue.code);
          const file = pattern?.exec(issue.message)?.[1];
          if (!file || !path.isAbsolute(file)) {
            return true;
          }
          if (issue.code === "active_sqlite_transcript_jsonl") {
            return Boolean(
              resolveActiveSqliteTranscriptFile(target, {
                sessionId: "migration-warning",
                sessionFile: file,
              }),
            );
          }
          const parsed = parseAgentSessionKey(issue.sessionKey);
          // Renamed legacy keys and unknown diagnostics cannot establish resolution.
          if (
            !issue.sessionKey ||
            !parsed ||
            normalizeAgentId(parsed.agentId) !== normalizeAgentId(target.agentId) ||
            normalizeStoreSessionKey(issue.sessionKey) !== issue.sessionKey
          ) {
            return true;
          }
          const hasSession = live.has(issue.sessionKey.toLowerCase());
          if (!hasSession && mainAliases.has(parsed.rest.toLowerCase())) {
            return true;
          }
          const current = countTranscriptEventsForPath(file);
          // Existing malformed originals still need repair even if a prefix was imported.
          if (current.status === "malformed") {
            return true;
          }
          const transcriptId =
            extractGeneratedTranscriptSessionId(file) ?? path.basename(file, ".jsonl");
          return (
            current.status === "missing" &&
            hasSession &&
            !transcripts.has(`${issue.sessionKey.toLowerCase()}\0${transcriptId}`)
          );
        });
      },
      { agentId: target.agentId, path: target.sqlitePath, env },
    );
    return read.found ? read.value : target.issues;
  } catch {
    // Missing, unreadable, or unsupported stores are not evidence of recovery.
    return target.issues;
  }
}

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
      for (const warning of formatSessionSqliteMigrationWarnings(
        [
          {
            ...target,
            issues: currentMigrationIssues(target, env).map((issue) =>
              issue.code === "active_sqlite_transcript_jsonl"
                ? {
                    code: issue.code,
                    sessionKey: issue.sessionKey,
                    message: issue.message.replace(
                      /Run openclaw doctor --fix or .*$/s,
                      "Run openclaw doctor --session-sqlite inspect to check current originals before choosing recovery.",
                    ),
                  }
                : issue,
            ),
          },
        ],
        env,
      )) {
        warnings.push(warning);
      }
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
