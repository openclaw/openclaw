import { existsSync } from "node:fs";
import path from "node:path";
import { getDatabaseEngineInput } from "../infra/database-engine/context.js";
import {
  assertStateDatabaseAccessAllowed,
  getStateDatabaseSchemaLease,
} from "../infra/gateway-state-owner.js";
import {
  hasOrphanedSqliteSidecars,
  quarantineOrphanedSqliteSidecars,
} from "../infra/sqlite-files.js";
import { deferSqliteSnapshotCleanupAfterRead } from "../infra/sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { withStateDatabaseSchemaMaintenance } from "../infra/state-database-maintenance.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateSchemaReadAdmission } from "./openclaw-state-db-contract.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { inspectOpenClawStateOwnershipWithWorker } from "./openclaw-state-ownership-worker.js";
import {
  assertOwnershipAllowsWrite,
  inspectOwnershipThroughConnection,
  parseExternalOwnership,
} from "./openclaw-state-ownership.js";

/** Check write admission; callers may defer orphan-sidecar recovery until mutation is certain. */
export async function assertOpenClawStateWriteAllowedAtPath(options: {
  databasePath: string;
  env?: NodeJS.ProcessEnv;
  recoverOrphanedSidecars?: boolean;
  signal?: AbortSignal;
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission;
}): Promise<void> {
  options.signal?.throwIfAborted();
  const databasePath = path.resolve(options.databasePath);
  assertStateDatabaseAccessAllowed(databasePath);
  const recoverOrphanedSidecars = options.recoverOrphanedSidecars !== false;
  if (recoverOrphanedSidecars && hasOrphanedSqliteSidecars(databasePath)) {
    withStateDatabaseSchemaMaintenance({ databasePath }, () =>
      quarantineOrphanedSqliteSidecars(databasePath),
    );
  }
  if (!existsSync(databasePath)) {
    return;
  }
  const env = options.env ?? process.env;
  if (getDatabaseEngineInput("state")) {
    const read = await executeExistingOpenClawStateRead(
      { path: databasePath, env },
      { type: "stateBootstrap.ownership", input: { pathname: databasePath } },
      { current: true, signal: options.signal },
    );
    options.signal?.throwIfAborted();
    assertStateDatabaseAccessAllowed(databasePath);
    assertOwnershipAllowsWrite(read?.ownership ?? null, databasePath, env);
    return;
  }
  // Offline admission belongs to this process. Its live scope/lease cannot be
  // borrowed by a native reader child; retain the private-copy path instead.
  if (
    !options.openStateSchemaReadAdmission &&
    !getOpenClawDatabaseMaintenanceScope() &&
    !getStateDatabaseSchemaLease(databasePath)
  ) {
    const ownershipJson = await inspectOpenClawStateOwnershipWithWorker(
      databasePath,
      options.signal,
    );
    options.signal?.throwIfAborted();
    assertStateDatabaseAccessAllowed(databasePath);
    assertOwnershipAllowsWrite(
      ownershipJson === "null" ? null : parseExternalOwnership(ownershipJson, databasePath),
      databasePath,
      env,
    );
    return;
  }
  const prepared = await prepareSqliteReadOnlyLocation(databasePath, {
    preserveSourceArtifacts: true,
    signal: options.signal,
  });
  let readSucceeded = false;
  try {
    options.signal?.throwIfAborted();
    assertStateDatabaseAccessAllowed(databasePath);
    assertOwnershipAllowsWrite(
      inspectOwnershipThroughConnection(
        prepared.location,
        databasePath,
        options.openStateSchemaReadAdmission,
      ),
      databasePath,
      env,
    );
    readSucceeded = true;
  } finally {
    await prepared.cleanupAsync().catch((error: unknown) => {
      if (!readSucceeded || !deferSqliteSnapshotCleanupAfterRead(error, prepared.cleanupRoot)) {
        throw error;
      }
    });
  }
}
