import fs from "node:fs";
import path from "node:path";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { hasErrnoCode } from "../infra/errno.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { resolveSqliteInspectionSignal } from "../infra/sqlite-readonly-worker.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { isLiveStateRead } from "./artifact-preserving-state-reads.js";
import { createAgentDatabaseLeaseStaleReasonReader } from "./openclaw-agent-db-lease-provenance.js";
import {
  OpenClawAgentDatabaseLeaseActiveError,
  readAgentDatabaseLeases,
} from "./openclaw-agent-db-lease.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import type {
  OpenClawStateDatabaseOptions,
  OpenClawStateSchemaReadAdmission,
} from "./openclaw-state-db-contract.js";
import { isStatePostgres } from "./openclaw-state-db-engine.js";
import { withOpenClawStateReadOnlyLocation } from "./openclaw-state-db-read-connection.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

/** Read-only diagnostic observation; an empty result never grants maintenance authority. */
export async function readActiveOpenClawAgentDatabaseLeasesReadOnly(
  options: OpenClawStateDatabaseOptions = {},
  admitSchema?: OpenClawStateSchemaReadAdmission,
  signal = resolveSqliteInspectionSignal(),
): Promise<ReturnType<typeof readAgentDatabaseLeases>> {
  signal?.throwIfAborted();
  const pathname = path.resolve(options.path ?? resolveOpenClawStateSqlitePath(options.env));
  try {
    await fs.promises.stat(pathname);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  // Doctor must inspect a restored database before clearing its quarantine receipt.
  const cached = openClawStateDatabaseCache.isOpenClawStateDatabaseOpen(pathname)
    ? openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(pathname)
    : undefined;
  if (!cached) {
    const prepared =
      isStatePostgres() || isLiveStateRead()
        ? undefined
        : await prepareSqliteReadOnlyLocation(pathname, {
            signal,
            preserveSourceArtifacts: true,
            requireCleanup: true,
          });
    try {
      signal?.throwIfAborted();
      return withEngineStoreAdmission(() =>
        withOpenClawStateReadOnlyLocation(
          ({ db }) => readActiveOpenClawAgentDatabaseLeasesInDatabase(db),
          pathname,
          prepared?.location ?? pathname,
          admitSchema,
          undefined,
          prepared?.cleanupRoot,
        ),
      );
    } finally {
      await prepared?.cleanupAsync();
    }
  }
  signal?.throwIfAborted();
  return withEngineStoreAdmission(() => {
    const closeAdmission = isPostgresSqlConnection(cached.db)
      ? undefined
      : admitSchema?.(cached.db);
    try {
      return readActiveOpenClawAgentDatabaseLeasesInDatabase(cached.db);
    } finally {
      closeAdmission?.();
    }
  });
}

/** A held shared-state transaction can inspect its own leases without another reader. */
export function readActiveOpenClawAgentDatabaseLeasesInDatabase(database: EngineConnection) {
  const read = () => {
    if (!tableExists(database, "agent_database_leases")) {
      return [];
    }
    const staleReasonFor = createAgentDatabaseLeaseStaleReasonReader();
    return readAgentDatabaseLeases(database).filter((row) => !staleReasonFor(row));
  };
  return isPostgresSqlConnection(database) ? read() : runWithSqliteBusyTimeout(database, 250, read);
}

/** Doctor holds both lifecycle coordinators before checking writers, without schema repair. */
export async function assertNoOpenClawAgentDatabaseLeasesReadOnly(
  options: OpenClawStateDatabaseOptions = {},
  admitSchema?: OpenClawStateSchemaReadAdmission,
  signal?: AbortSignal,
): Promise<void> {
  const owners = await readActiveOpenClawAgentDatabaseLeasesReadOnly(options, admitSchema, signal);
  const [owner] = owners;
  if (owner) {
    throw new OpenClawAgentDatabaseLeaseActiveError(
      `Agent ${owner.agent_id} database is still open in process ${owner.owner_pid}; stop the Gateway and other OpenClaw processes, or reboot, then rerun openclaw doctor --fix.`,
      [...new Set(owners.map((row) => row.owner_pid))],
    );
  }
}
