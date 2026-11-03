import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { extractGeneratedTranscriptSessionId } from "../config/sessions/generated-transcript-session-id.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { readCanonicalSessionMainKey } from "../config/sessions/session-canonical-key.js";
import { normalizeStoreSessionKey } from "../config/sessions/store-entry.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  formatMigrationWarningSummary,
  MIGRATION_WARNING_EXAMPLE_LIMIT,
} from "../infra/migration-warning-summary.js";
import { isSessionSqliteMigrationWarning } from "../infra/session-sqlite-migration-issues.js";
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
