import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  assertStateDatabaseAccessAllowed,
  getStateDatabaseSchemaLease,
  GatewayStateOwnerContentionError,
} from "../infra/gateway-state-owner.js";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../infra/sqlite-database-admission.js";
import { isSqliteLockError, withSqliteNativeOpen } from "../infra/sqlite-error-diagnostics.js";
import {
  hasOrphanedSqliteSidecars,
  quarantineOrphanedSqliteSidecars,
} from "../infra/sqlite-files.js";
import {
  OpenClawStateExternalOwnershipError,
  OpenClawStateOwnershipMetadataError,
} from "../infra/sqlite-lifecycle-errors.js";
import { deferSqliteSnapshotCleanupAfterRead } from "../infra/sqlite-readonly-location-cleanup.js";
import {
  prepareSqliteReadOnlyLocationSyncInProcess,
  readSourceJournalMode,
  readSourceSidecars,
} from "../infra/sqlite-readonly-location.js";
import {
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationSync,
} from "../infra/sqlite-snapshot-source.js";
import { withSqliteSourceReadDatabase } from "../infra/sqlite-source-handle.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import {
  StateSchemaMutationConflictError,
  withStateDatabaseSchemaMaintenance,
} from "../infra/state-database-maintenance.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateSchemaReadAdmission,
} from "./openclaw-state-db-contract.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { normalizeOpenClawStateSchemaReadError } from "./openclaw-state-db-schema-migration-required.js";
import { inspectOpenClawStateOwnershipWithWorker } from "./openclaw-state-ownership-worker.js";

export const STATE_SUPERVISION_KEY = "gateway.supervision";
const MAX_OWNERSHIP_TIMESTAMP_MS = 8_640_000_000_000_000;
const MANAGER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type OpenClawExternalStateOwnership = {
  claimedAt: number;
  managerId: string;
  mode: "external";
  version: 1;
};

const ownershipAdmission: SqliteDatabaseAdmissionKey<OpenClawExternalStateOwnership | null> = {
  name: "state.external-ownership",
  read(value) {
    if (value === null) {
      return null;
    }
    if (
      isRecord(value) &&
      value.version === 1 &&
      value.mode === "external" &&
      typeof value.managerId === "string" &&
      typeof value.claimedAt === "number"
    ) {
      return {
        version: 1,
        mode: "external",
        managerId: value.managerId,
        claimedAt: value.claimedAt,
      };
    }
    return undefined;
  },
};

/** The ownership writer publishes at its outer commit; lease loss remains a live authority check. */
export function publishOpenClawStateOwnership(
  database: DatabaseSync,
  ownership: OpenClawExternalStateOwnership,
): void {
  publishSqliteDatabaseAdmission(database, ownershipAdmission, { ...ownership });
}

export function isOpenClawStateWriteContentionError(error: unknown): boolean {
  return (
    error instanceof GatewayStateOwnerContentionError ||
    error instanceof StateSchemaMutationConflictError ||
    isSqliteLockError(error)
  );
}

export function normalizeOpenClawStateManagerId(managerId: string): string {
  const normalized = managerId.trim();
  if (!MANAGER_ID_PATTERN.test(normalized)) {
    throw new Error(
      "External state ownership manager id must be a 1-128 character ASCII identifier.",
    );
  }
  return normalized;
}

function parseExternalOwnership(
  valueJson: string,
  databasePath: string,
): OpenClawExternalStateOwnership {
  let value: unknown;
  try {
    value = JSON.parse(valueJson) as unknown;
  } catch {
    throw new OpenClawStateOwnershipMetadataError(databasePath, "reserved value is not valid JSON");
  }
  const record = isRecord(value) ? value : undefined;
  const keys = record ? Object.keys(record).toSorted().join(",") : "";
  const managerId = record?.managerId;
  const claimedAt = record?.claimedAt;
  if (
    keys !== "claimedAt,managerId,mode,version" ||
    record?.version !== 1 ||
    record?.mode !== "external" ||
    typeof managerId !== "string" ||
    !MANAGER_ID_PATTERN.test(managerId) ||
    typeof claimedAt !== "number" ||
    !Number.isSafeInteger(claimedAt) ||
    claimedAt < 0 ||
    claimedAt > MAX_OWNERSHIP_TIMESTAMP_MS
  ) {
    throw new OpenClawStateOwnershipMetadataError(
      databasePath,
      "reserved value does not match the version 1 external ownership contract",
    );
  }
  return {
    version: 1,
    mode: "external",
    managerId,
    claimedAt,
  };
}

/** Inspect the reserved ownership row without entering the shared-state lifecycle. */
export function inspectOpenClawStateOwnershipFromDatabase(
  database: DatabaseSync,
  databasePath: string,
  configMachineStateTableReady = false,
): OpenClawExternalStateOwnership | null {
  try {
    if (!configMachineStateTableReady && !tableExists(database, "config_machine_state")) {
      return null;
    }
    // Raw admission must not mistake a damaged ownership index for an unclaimed store.
    const ownershipSql = configMachineStateTableReady
      ? "SELECT value_json FROM config_machine_state WHERE state_key = ? LIMIT 1"
      : "SELECT value_json FROM config_machine_state NOT INDEXED WHERE state_key = ? LIMIT 1";
    const row = database.prepare(ownershipSql).get(STATE_SUPERVISION_KEY) as
      | { value_json?: unknown }
      | undefined;
    if (!row) {
      return null;
    }
    if (typeof row.value_json !== "string") {
      throw new OpenClawStateOwnershipMetadataError(databasePath, "reserved value is not text");
    }
    return parseExternalOwnership(row.value_json, databasePath);
  } catch (error) {
    throw normalizeOpenClawStateSchemaReadError(error, databasePath);
  }
}

function inspectOwnershipThroughConnection(
  location: string,
  databasePath: string,
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission,
): OpenClawExternalStateOwnership | null {
  const database = withSqliteNativeOpen(() => openNodeSqliteDatabase(location, { readOnly: true }));
  let closeAdmission: (() => void) | undefined;
  try {
    closeAdmission = openStateSchemaReadAdmission?.(database);
    database.exec(
      `PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS}; PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;`,
    );
    return inspectOpenClawStateOwnershipFromDatabase(database, databasePath);
  } finally {
    try {
      closeAdmission?.();
    } finally {
      database.close();
    }
  }
}

/** Inspect one resolved state database path without mutating its state tree. */
export function inspectOpenClawStateOwnershipAtPath(
  databasePath: string,
): OpenClawExternalStateOwnership | null {
  const resolvedPath = path.resolve(databasePath);
  if (!existsSync(resolvedPath)) {
    return null;
  }
  const prepared = prepareSqliteReadOnlyLocationSync(resolvedPath);
  try {
    return inspectOwnershipThroughConnection(prepared.location, resolvedPath);
  } finally {
    prepared.cleanup();
  }
}

/** Runs only in an isolated child: closing a source must not release a live writer's locks. */
export function inspectOpenClawStateOwnershipInProcess(
  databasePath: string,
): OpenClawExternalStateOwnership | null {
  const sidecars = readSourceSidecars(databasePath);
  if (
    readSourceJournalMode(databasePath) === "wal" &&
    sidecars.wal &&
    sidecars.shm &&
    !sidecars.journal
  ) {
    return withSqliteSourceReadDatabase(databasePath, "source", (database) => {
      database.exec(
        `PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS}; PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;`,
      );
      return runSqliteDeferredTransactionSync(
        database,
        () => inspectOpenClawStateOwnershipFromDatabase(database, databasePath),
        { operationLabel: "state.ownership.inspect" },
      );
    });
  }
  // Incomplete and recovery-required families retain private artifact-preserving inspection.
  const prepared = prepareSqliteReadOnlyLocationSyncInProcess(databasePath);
  try {
    return inspectOwnershipThroughConnection(prepared.location, databasePath);
  } finally {
    prepared.cleanup();
  }
}

function assertOwnershipAllowsWrite(
  status: OpenClawExternalStateOwnership | null,
  databasePath: string,
  env: NodeJS.ProcessEnv,
): void {
  if (status && !isGatewayExternallySupervised(env)) {
    throw new OpenClawStateExternalOwnershipError(databasePath, status.managerId);
  }
}

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

/** Fence shared-state writes once an external manager has claimed ownership. */
export function assertOpenClawStateWriteAllowed(options: {
  database: DatabaseSync;
  databasePath: string;
  env?: NodeJS.ProcessEnv;
  // Only the shared-state lifecycle owner may carry this positive schema fact.
  // Close/reopen and replacement bootstrap a new owner before setting it again.
  schemaReady?: boolean;
  /** Doctor and explicit repair inspect durable ownership before their mutations. */
  inspectOwnership?: true;
}): void {
  const resolvedPath = path.resolve(options.databasePath);
  assertStateDatabaseAccessAllowed(resolvedPath);
  let status = options.inspectOwnership
    ? undefined
    : getSqliteDatabaseAdmission(options.database, ownershipAdmission);
  if (status === undefined) {
    const inspected = inspectOpenClawStateOwnershipFromDatabase(
      options.database,
      resolvedPath,
      options.schemaReady,
    );
    status = options.inspectOwnership
      ? undefined
      : getSqliteDatabaseAdmission(options.database, ownershipAdmission);
    if (status === undefined) {
      status = inspected;
      publishSqliteDatabaseAdmission(options.database, ownershipAdmission, status);
    }
  }
  assertOwnershipAllowsWrite(status, resolvedPath, options.env ?? process.env);
}
