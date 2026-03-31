/**
 * Session store migration command.
 * Migrates sessions from JSON to SQLite storage backend.
 */
import { loadConfig } from "../config/config.js";
import {
  getSessionStoreStats,
  isSqliteAvailable,
} from "../config/sessions/store-facade.js";
import {
  getSessionCountSqlite,
  migrateJsonToSqlite,
  resolveSqlitePathFromJsonPath,
  sqliteStoreExists,
} from "../config/sessions/store-sqlite.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { info, warn } from "../globals.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { isRich, theme } from "../terminal/theme.js";
import { resolveSessionStoreTargetsOrExit } from "./session-store-targets.js";

export type SessionsMigrateOptions = {
  store?: string;
  agent?: string;
  allAgents?: boolean;
  dryRun?: boolean;
  json?: boolean;
};

export type MigrationResult = {
  agentId: string;
  jsonPath: string;
  sqlitePath: string;
  status: "migrated" | "skipped" | "failed" | "no_data";
  migratedCount: number;
  existingSqliteCount: number;
  message: string;
};

export async function sessionsMigrateCommand(
  opts: SessionsMigrateOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = loadConfig();
  const rich = isRich();

  // Check SQLite availability first
  if (!isSqliteAvailable()) {
    if (opts.json) {
      writeRuntimeJson(runtime, {
        success: false,
        error: "SQLite is not available in this Node runtime (requires Node 22.5+)",
      });
    } else {
      warn("SQLite is not available in this Node runtime.");
      info("SQLite support requires Node.js 22.5 or later with the built-in node:sqlite module.");
    }
    runtime.exit(1);
    return;
  }

  const targets = resolveSessionStoreTargetsOrExit({
    cfg,
    opts: {
      store: opts.store,
      agent: opts.agent,
      allAgents: opts.allAgents ?? false,
    },
    runtime,
  });

  if (!targets) {
    return;
  }

  const results: MigrationResult[] = [];

  for (const target of targets) {
    const jsonPath = target.storePath;
    const sqlitePath = resolveSqlitePathFromJsonPath(jsonPath);
    const agentId = normalizeAgentId(target.agentId);

    const result: MigrationResult = {
      agentId,
      jsonPath,
      sqlitePath,
      status: "no_data",
      migratedCount: 0,
      existingSqliteCount: 0,
      message: "",
    };

    // Check if SQLite already has data
    if (sqliteStoreExists(sqlitePath)) {
      const count = getSessionCountSqlite(sqlitePath);
      if (count > 0) {
        result.status = "skipped";
        result.existingSqliteCount = count;
        result.message = `SQLite store already has ${count} sessions`;
        results.push(result);
        continue;
      }
    }

    // Dry run mode
    if (opts.dryRun) {
      const stats = getSessionStoreStats(jsonPath);
      result.status = "skipped";
      result.message = `Would migrate sessions from ${jsonPath} to ${sqlitePath}`;
      results.push(result);
      continue;
    }

    // Perform migration
    try {
      const migratedCount = migrateJsonToSqlite(jsonPath, sqlitePath);
      if (migratedCount === 0) {
        result.status = "no_data";
        result.message = "No sessions to migrate";
      } else {
        result.status = "migrated";
        result.migratedCount = migratedCount;
        result.message = `Migrated ${migratedCount} sessions`;
      }
    } catch (err) {
      result.status = "failed";
      result.message = err instanceof Error ? err.message : String(err);
    }

    results.push(result);
  }

  // Output results
  if (opts.json) {
    writeRuntimeJson(runtime, {
      success: results.every((r) => r.status !== "failed"),
      results,
    });
    return;
  }

  // Text output
  const totalMigrated = results.reduce((sum, r) => sum + r.migratedCount, 0);
  const failed = results.filter((r) => r.status === "failed");
  const skipped = results.filter((r) => r.status === "skipped");
  const migrated = results.filter((r) => r.status === "migrated");
  const noData = results.filter((r) => r.status === "no_data");

  info("");
  info(rich ? theme.heading("Session Store Migration") : "Session Store Migration");
  info("");

  for (const result of results) {
    const statusLabel =
      result.status === "migrated"
        ? rich
          ? theme.success("MIGRATED")
          : "MIGRATED"
        : result.status === "skipped"
          ? rich
            ? theme.muted("SKIPPED")
            : "SKIPPED"
          : result.status === "failed"
            ? rich
              ? theme.error("FAILED")
              : "FAILED"
            : rich
              ? theme.muted("NO_DATA")
              : "NO_DATA";

    info(`  ${statusLabel}  ${result.agentId}`);
    info(`    ${result.message}`);
    if (result.status === "migrated") {
      info(`    ${rich ? theme.muted("SQLite:") : "SQLite:"} ${result.sqlitePath}`);
    }
    info("");
  }

  // Summary
  if (migrated.length > 0) {
    info(
      rich
        ? theme.success(`Migrated ${totalMigrated} sessions across ${migrated.length} agent(s).`)
        : `Migrated ${totalMigrated} sessions across ${migrated.length} agent(s).`,
    );
  }
  if (skipped.length > 0) {
    info(
      rich
        ? theme.muted(
            `Skipped ${skipped.length} agent(s) (SQLite already populated or dry-run mode).`,
          )
        : `Skipped ${skipped.length} agent(s) (SQLite already populated or dry-run mode).`,
    );
  }
  if (noData.length > 0) {
    info(
      rich
        ? theme.muted(`${noData.length} agent(s) had no sessions to migrate.`)
        : `${noData.length} agent(s) had no sessions to migrate.`,
    );
  }
  if (failed.length > 0) {
    warn(`${failed.length} agent(s) failed to migrate.`);
    runtime.exit(1);
    return;
  }

  // Hint about config
  if (migrated.length > 0) {
    info("");
    info(
      rich
        ? theme.muted(
            'Tip: Set session.storeType: "sqlite" in your openclaw.json to use SQLite by default.',
          )
        : 'Tip: Set session.storeType: "sqlite" in your openclaw.json to use SQLite by default.',
    );
  }
}

export type SessionsStoreInfoOptions = {
  store?: string;
  agent?: string;
  json?: boolean;
};

export async function sessionsStoreInfoCommand(
  opts: SessionsStoreInfoOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const rich = isRich();

  const jsonPath = resolveStorePath(opts.store, { agentId: opts.agent });
  const stats = getSessionStoreStats(jsonPath);

  if (opts.json) {
    writeRuntimeJson(runtime, stats);
    return;
  }

  info("");
  info(rich ? theme.heading("Session Store Info") : "Session Store Info");
  info("");
  info(`  Configured Type:  ${stats.storeType}`);
  info(`  Effective Type:   ${stats.effectiveStoreType}`);
  info(`  SQLite Available: ${stats.sqliteAvailable ? "yes" : "no"}`);
  info(`  Session Count:    ${stats.sessionCount}`);
  info("");
  info(`  JSON Path:        ${stats.jsonPath}`);
  if (stats.sqlitePath) {
    info(`  SQLite Path:      ${stats.sqlitePath}`);
  }
  info("");
}
