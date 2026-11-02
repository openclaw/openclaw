import fs from "node:fs";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { SqlConnection } from "../infra/sql-connection.js";
import { SqliteSnapshotCleanupError } from "../infra/sqlite-readonly-location-cleanup.js";
import { resolveSqliteInspectionSignal } from "../infra/sqlite-readonly-worker.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { readRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry-listing.js";
import { openOpenClawStateReadConnection } from "../state/openclaw-state-db-read-connection.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import { BLOAT_MIN_FILE_BYTES } from "./doctor-db-bloat.constants.js";

export type SqliteBloatStats = {
  fileBytes: number;
  freeBytes: number;
  incrementalAutoVacuum: boolean;
};

async function readSqliteBloatStats(
  pathname: string,
  signal?: AbortSignal,
): Promise<SqliteBloatStats | null> {
  signal?.throwIfAborted();
  let fileBytes: number;
  try {
    fileBytes = fs.statSync(pathname, { throwIfNoEntry: false })?.size ?? 0;
  } catch {
    return null;
  }
  // Both warnings require this captured main-file size, even when WAL adds pages.
  // Smaller files cannot produce a finding, so avoid preparing their private copy.
  if (fileBytes < BLOAT_MIN_FILE_BYTES) {
    return null;
  }
  let stats: SqliteBloatStats | null = null;
  let failure: { error: unknown } | undefined;
  let connection: ReturnType<typeof openOpenClawStateReadConnection> | undefined;
  let snapshot: Awaited<ReturnType<typeof prepareSqliteReadOnlyLocation>> | undefined;
  try {
    // Inspect private bytes: even a read-only SQLite open can create source sidecars.
    snapshot = await prepareSqliteReadOnlyLocation(pathname, {
      preserveSourceArtifacts: true,
      signal,
    });
    connection = openOpenClawStateReadConnection(pathname, snapshot.location);
    const db = connection.database.db;
    const pageSize = readPragmaNumber(db, "page_size") ?? 4096;
    const freelistCount = readPragmaNumber(db, "freelist_count") ?? 0;
    const autoVacuum = readPragmaNumber(db, "auto_vacuum") ?? 0;
    stats = {
      fileBytes,
      freeBytes: freelistCount * pageSize,
      incrementalAutoVacuum: autoVacuum === 2,
    };
  } catch (error) {
    if (error instanceof SqliteSnapshotCleanupError || signal?.aborted) {
      failure = { error: error instanceof SqliteSnapshotCleanupError ? error : signal?.reason };
    }
    // Unavailable individual databases do not prevent the remaining diagnostics.
  }
  const closed = connection?.close() ?? true;
  if (!closed) {
    throw new SqliteSnapshotCleanupError("Doctor database size reader cleanup failed.");
  }
  if (snapshot && !(await snapshot.cleanupAsync())) {
    throw new SqliteSnapshotCleanupError("Doctor database size snapshot cleanup failed.");
  }
  if (failure) {
    throw failure.error;
  }
  return stats;
}

function readPragmaNumber(db: SqlConnection, pragma: string): number | null {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  return asFiniteNumber(row?.[pragma]) ?? null;
}

export async function readSqliteDatabaseBloat(params: {
  path: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}) {
  const signal = resolveSqliteInspectionSignal(params.signal);
  const results: Array<{ label: string; stats: SqliteBloatStats }> = [];
  const stateStats = await readSqliteBloatStats(params.path, signal);
  if (stateStats) {
    results.push({ label: "state DB", stats: stateStats });
  }
  const registered = await withArtifactPreservingStateReads(() =>
    // Prepare the registry source before its synchronous worker-local query.
    withOpenClawStateDatabaseReadSnapshot(async () => readRegisteredAgentDatabases(params, false), {
      ...params,
      signal,
    }),
  );
  for (const entry of registered) {
    const stats = await readSqliteBloatStats(entry.path, signal);
    if (stats) {
      results.push({ label: `agent DB (${entry.agentId})`, stats });
    }
  }
  return results;
}
