import { formatCliCommand } from "../cli/command-format.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { readCanonicalSessionMainKey } from "../config/sessions/session-canonical-key.js";
import { normalizeStoreSessionKey } from "../config/sessions/store-entry.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { isSessionSqliteMigrationWarning } from "../infra/session-sqlite-migration-issues.js";
import {
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
  type SessionSqliteMigrationTargetManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
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

/**
 * Missing-transcript keys whose session row is gone from the live store, for example after
 * `openclaw sessions cleanup --fix-missing`: nothing is left to repair. Presentation only;
 * manifests keep every finding, and any read failure keeps the warning visible.
 */
function listPrunedMissingTranscriptKeys(
  target: SessionSqliteMigrationTargetManifest,
  env: NodeJS.ProcessEnv,
): ReadonlySet<string> {
  const agentId = normalizeAgentId(target.agentId);
  // Import stores the exact legacy key, and canonical-key repair may later rename bare,
  // non-normalized, main-alias, or delivery-cased keys. Only a normalized key owned by this
  // store can prove its row is gone; every other key keeps its warning.
  const sessionKeys = new Map<string, string>();
  for (const issue of target.issues) {
    const parsed = issue.code === "transcript_missing" && parseAgentSessionKey(issue.sessionKey);
    if (
      parsed &&
      issue.sessionKey &&
      normalizeAgentId(parsed.agentId) === agentId &&
      normalizeStoreSessionKey(issue.sessionKey) === issue.sessionKey
    ) {
      sessionKeys.set(issue.sessionKey, parsed.rest.toLowerCase());
    }
  }
  if (sessionKeys.size === 0) {
    return new Set();
  }
  try {
    const read = withOpenClawAgentDatabaseReadOnly(
      (database) => {
        const mainAliases = new Set(["main", readCanonicalSessionMainKey(database)]);
        // Case-insensitive: repair may restore a delivery-proven mixed-case peer id.
        const liveKeys = new Set(
          executeSqliteQuerySync(
            database.db,
            getSessionKysely(database.db).selectFrom("session_nodes").select("session_key"),
          ).rows.map((row) => row.session_key.toLowerCase()),
        );
        return [...sessionKeys].flatMap(([sessionKey, rest]) =>
          mainAliases.has(rest) || liveKeys.has(sessionKey.toLowerCase()) ? [] : [sessionKey],
        );
      },
      { agentId: target.agentId, path: target.sqlitePath, env },
    );
    return new Set(read.found ? read.value : []);
  } catch {
    return new Set();
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
      const pruned = listPrunedMissingTranscriptKeys(target, env);
      const issues = target.issues.filter(
        (issue) =>
          issue.code !== "transcript_missing" || !issue.sessionKey || !pruned.has(issue.sessionKey),
      );
      warnings.push(...formatSessionSqliteMigrationWarnings([{ ...target, issues }], env));
    }
  }
  return warnings;
}
