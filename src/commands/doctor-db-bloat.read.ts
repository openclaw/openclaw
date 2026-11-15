import fs from "node:fs";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { SqlConnection } from "../infra/sql-connection.js";
import { SqliteSnapshotCleanupError } from "../infra/sqlite-lifecycle-errors.js";
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

const SQLITE_HEADER_BYTES = 100;
// "SQLite format 3\0" as header bytes; compared manually to avoid Buffer-prototype helpers.
const SQLITE_HEADER_MAGIC = [
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
];

function isSqliteStoredPageSize(pageSize: number): boolean {
  // The stored value 1 means 65536; every other valid size is a power of two in
  // [512, 32768] and cannot encode 65536 directly.
  if (pageSize === 1) {
    return true;
  }
  return pageSize >= 512 && pageSize <= 32768 && (pageSize & (pageSize - 1)) === 0;
}

/**
 * Returns the -wal sidecar size, 0 when absent, or null when it cannot be read.
 * Null means "unknown" and callers must treat the WAL as active.
 */
function readWalSidecarBytes(pathname: string): number | null {
  try {
    return fs.statSync(`${pathname}-wal`, { throwIfNoEntry: false })?.size ?? 0;
  } catch {
    return null;
  }
}

/**
 * Reads bloat stats from the 100-byte SQLite header without opening the database.
 * The three values this check reports (page size, freelist count, auto-vacuum mode)
 * all live in the header, so a raw read avoids the size-scaled snapshot copy and the
 * sidecar creation risk that motivates it. Returns null whenever the header does
 * not validate — non-SQLite files, truncated headers, values outside physical
 * bounds, WAL files with a live sidecar — so callers fall back to the snapshot
 * path. Validation cannot certify every mid-write state (a torn page-1 write can
 * keep a plausible shape), so unvalidatable doubt stays on the fallback. WAL-mode
 * files answer from the header only when their -wal sidecar is absent or empty;
 * uncheckpointed WAL frames can hold committed freelist changes the header cannot
 * see (page 1 is only rewritten at checkpoints), so a non-empty sidecar falls back
 * to the snapshot path where the PRAGMA answer preserves the reclaimable-bytes contract.
 */
async function readSqliteBloatStatsFromHeader(
  pathname: string,
  fileBytes: number,
): Promise<SqliteBloatStats | null> {
  let bytes: Uint8Array;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(pathname, "r");
    bytes = new Uint8Array(SQLITE_HEADER_BYTES);
    const { bytesRead } = await handle.read(bytes, 0, SQLITE_HEADER_BYTES, 0);
    if (bytesRead < SQLITE_HEADER_BYTES) {
      return null;
    }
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
  for (let index = 0; index < SQLITE_HEADER_MAGIC.length; index += 1) {
    if (bytes[index] !== SQLITE_HEADER_MAGIC[index]) {
      return null;
    }
  }
  const header = new DataView(bytes.buffer);
  const storedPageSize = header.getUint16(16, false);
  if (!isSqliteStoredPageSize(storedPageSize)) {
    return null;
  }
  // Header offsets 18/19 hold the file-format write/read versions: 1 = rollback
  // journal, 2 = WAL. A WAL file with a non-empty sidecar may carry committed
  // freelist changes in uncheckpointed frames, so its header count is stale in
  // either direction; an absent or empty sidecar means the header is current.
  const writeVersion = header.getUint8(18);
  const readVersion = header.getUint8(19);
  if ((writeVersion !== 1 && writeVersion !== 2) || (readVersion !== 1 && readVersion !== 2)) {
    return null;
  }
  if (writeVersion === 2 || readVersion === 2) {
    const walBytes = readWalSidecarBytes(pathname);
    if (walBytes === null || walBytes > 0) {
      return null;
    }
  }
  const pageSize = storedPageSize === 1 ? 65536 : storedPageSize;
  const freelistCount = header.getUint32(36, false);
  // Every freelist page lives inside the main file, so a count whose byte span
  // exceeds the captured size is a damaged header — take the fallback instead of
  // reporting impossible reclaimable bytes.
  if (freelistCount > 0 && freelistCount * pageSize > fileBytes) {
    return null;
  }
  const largestRootBTreePage = header.getUint32(52, false);
  const incrementalVacuumFlag = header.getUint32(64, false);
  const autoVacuum = largestRootBTreePage === 0 ? 0 : incrementalVacuumFlag !== 0 ? 2 : 1;
  return {
    fileBytes,
    freeBytes: freelistCount * pageSize,
    incrementalAutoVacuum: autoVacuum === 2,
  };
}

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
  // Reporting-size files are exactly where the snapshot copy is most expensive;
  // a validated header read answers this check without one.
  const headerStats = await readSqliteBloatStatsFromHeader(pathname, fileBytes);
  if (headerStats) {
    return headerStats;
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
