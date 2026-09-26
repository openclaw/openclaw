import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  assertStateDatabaseAccessAllowed,
  GatewayStateOwnerContentionError,
} from "../infra/gateway-state-owner.js";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { isSqliteLockError, withSqliteNativeOpen } from "../infra/sqlite-error-diagnostics.js";
import {
  hasOrphanedSqliteSidecars,
  quarantineOrphanedSqliteSidecars,
} from "../infra/sqlite-files.js";
import {
  OpenClawStateExternalOwnershipError,
  OpenClawStateOwnershipMetadataError,
} from "../infra/sqlite-lifecycle-errors.js";
import {
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationSync,
} from "../infra/sqlite-snapshot-source.js";
import {
  StateSchemaMutationConflictError,
  withStateDatabaseSchemaMaintenance,
} from "../infra/state-database-maintenance.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateSchemaReadAdmission,
} from "./openclaw-state-db-contract.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { normalizeOpenClawStateSchemaReadError } from "./openclaw-state-db-schema-migration-required.js";

export const STATE_SUPERVISION_KEY = "gateway.supervision";
const MAX_OWNERSHIP_TIMESTAMP_MS = 8_640_000_000_000_000;
const MANAGER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type OpenClawExternalStateOwnership = {
  claimedAt: number;
  managerId: string;
  mode: "external";
  version: 1;
};

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

function inspectJournalAwarePublicOwnership(
  databasePath: string,
): OpenClawExternalStateOwnership | null {
  const prepared = prepareSqliteReadOnlyLocationSync(databasePath);
  try {
    return inspectOwnershipThroughConnection(prepared.location, databasePath);
  } finally {
    prepared.cleanup();
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
  return inspectJournalAwarePublicOwnership(resolvedPath);
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
  const prepared = await prepareSqliteReadOnlyLocation(databasePath, {
    preserveSourceArtifacts: true,
    signal: options.signal,
  });
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
  } finally {
    await prepared.cleanupAsync();
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
}): void {
  const resolvedPath = path.resolve(options.databasePath);
  assertStateDatabaseAccessAllowed(resolvedPath);
  const status = inspectOpenClawStateOwnershipFromDatabase(
    options.database,
    resolvedPath,
    options.schemaReady,
  );
  assertOwnershipAllowsWrite(status, resolvedPath, options.env ?? process.env);
}
