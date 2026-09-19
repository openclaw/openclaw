import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { SqliteSnapshotCleanupError } from "../infra/sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationSync } from "../infra/sqlite-snapshot-source.js";
import { readRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry-listing.js";
import { openOpenClawStateReadConnection } from "../state/openclaw-state-db-read-connection.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";

export type SqliteBloatStats = {
  fileBytes: number;
  freeBytes: number;
  incrementalAutoVacuum: boolean;
};

function readSqliteBloatStats(pathname: string): SqliteBloatStats | null {
  let fileBytes: number;
  try {
    fileBytes = fs.statSync(pathname, { throwIfNoEntry: false })?.size ?? 0;
  } catch {
    return null;
  }
  if (fileBytes <= 0) {
    return null;
  }
  let connection: ReturnType<typeof openOpenClawStateReadConnection> | undefined;
  try {
    // Inspect private bytes: even a read-only SQLite open can create source sidecars.
    connection = openOpenClawStateReadConnection(
      pathname,
      prepareSqliteReadOnlyLocationSync(pathname),
    );
    const db = connection.database.db;
    const pageSize = readPragmaNumber(db, "page_size") ?? 4096;
    const freelistCount = readPragmaNumber(db, "freelist_count") ?? 0;
    const autoVacuum = readPragmaNumber(db, "auto_vacuum") ?? 0;
    return {
      fileBytes,
      freeBytes: freelistCount * pageSize,
      incrementalAutoVacuum: autoVacuum === 2,
    };
  } catch (error) {
    if (error instanceof SqliteSnapshotCleanupError) {
      throw error;
    }
    // Unavailable individual databases do not prevent the remaining diagnostics.
    return null;
  } finally {
    connection?.close();
  }
}

function readPragmaNumber(db: DatabaseSync, pragma: string): number | null {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  return asFiniteNumber(row?.[pragma]) ?? null;
}

export function readSqliteDatabaseBloat(params: { path: string; env: NodeJS.ProcessEnv }) {
  const results: Array<{ label: string; stats: SqliteBloatStats }> = [];
  const stateStats = readSqliteBloatStats(params.path);
  if (stateStats) {
    results.push({ label: "state DB", stats: stateStats });
  }
  const registered = withArtifactPreservingStateReads(() =>
    // The worker cannot share the host memo's registration invalidations.
    readRegisteredAgentDatabases(params, false),
  );
  for (const entry of registered) {
    const stats = readSqliteBloatStats(entry.path);
    if (stats) {
      results.push({ label: `agent DB (${entry.agentId})`, stats });
    }
  }
  return results;
}
