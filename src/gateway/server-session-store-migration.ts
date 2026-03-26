import path from "node:path";
import { listAgentSessionDirs } from "../commands/cleanup-utils.js";
import type { SessionStoreMigrationResult } from "../config/sessions/store-directory.js";
import { migrateSessionStoreToDirectory } from "../config/sessions/store.js";

type SessionStoreMigrationLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

function summarizeSessionStoreMigrationResults(results: SessionStoreMigrationResult[]): {
  message: string;
  level: "info" | "warn";
} | null {
  if (results.length === 0) {
    return null;
  }

  const counts = {
    inspected: results.length,
    migrated: 0,
    alreadyDirectory: 0,
    skippedEmpty: 0,
    skippedInvalid: 0,
    missing: 0,
    failed: 0,
  };
  const issues: string[] = [];

  for (const result of results) {
    switch (result.outcome) {
      case "migrated":
        counts.migrated += 1;
        break;
      case "already_directory":
        counts.alreadyDirectory += 1;
        break;
      case "skipped_empty":
        counts.skippedEmpty += 1;
        break;
      case "skipped_invalid":
        counts.skippedInvalid += 1;
        issues.push(`${result.storePath} (invalid legacy store)`);
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "missing":
        counts.missing += 1;
        break;
    }
    for (const warning of result.warnings) {
      issues.push(`${result.storePath} (${warning})`);
    }
  }

  const message =
    `session-store migration summary: inspected=${counts.inspected} ` +
    `migrated=${counts.migrated} already_directory=${counts.alreadyDirectory} ` +
    `skipped_empty=${counts.skippedEmpty} skipped_invalid=${counts.skippedInvalid} ` +
    `missing=${counts.missing} failed=${counts.failed}` +
    (issues.length > 0 ? `; issues: ${issues.join("; ")}` : "");
  return {
    message,
    level: counts.skippedInvalid > 0 || counts.failed > 0 ? "warn" : "info",
  };
}

/**
 * Migrate discovered session stores at gateway startup and emit an aggregated summary.
 */
export async function runStartupSessionStoreMigration(params: {
  stateDir: string;
  configuredStorePath?: string;
  log: SessionStoreMigrationLogger;
}): Promise<SessionStoreMigrationResult[]> {
  const migrationTargets = new Set<string>();
  for (const sessionsDir of await listAgentSessionDirs(params.stateDir)) {
    migrationTargets.add(path.join(sessionsDir, "sessions.json"));
  }
  if (params.configuredStorePath) {
    migrationTargets.add(params.configuredStorePath);
  }

  const results: SessionStoreMigrationResult[] = [];
  for (const storePath of migrationTargets) {
    try {
      results.push(await migrateSessionStoreToDirectory(storePath));
    } catch (err) {
      results.push({
        storePath,
        outcome: "failed",
        legacyEntries: 0,
        migratedEntries: 0,
        warnings: [`Migration failed: ${String(err)}`],
      });
    }
  }

  const summary = summarizeSessionStoreMigrationResults(results);
  if (summary) {
    params.log[summary.level](summary.message);
  }
  return results;
}
