import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import type { SqliteIntegrityCheck } from "../infra/sqlite-integrity.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { prepareSqliteReadOnlyLocationSync } from "../infra/sqlite-snapshot-source.js";
import { SqliteWorkerOpenRefusedError } from "../infra/sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import {
  AgentDatabaseDeletionRefusedError,
  assertAgentDeletionPathFence,
  prepareAgentDeletionPathFence,
} from "./agent-deletion-journal.js";
import { withExistingAgentLeaseWrite } from "./openclaw-agent-db-existing-write.js";
import {
  agentDatabaseLeaseStaleReason,
  mayShareAgentDatabaseFile,
  readAgentDatabaseLeaseProvenance,
  agentDatabaseLeaseProcessDeathRefusal,
} from "./openclaw-agent-db-lease-provenance.js";
import { agentDatabaseMaintenanceAuthority as maintenanceAuthority } from "./openclaw-agent-db-maintenance-authority.js";
import {
  invalidateOpenClawAgentDatabaseValidation,
  type OpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import { ensureOpenClawQuarantineStore } from "./openclaw-quarantine-store.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import {
  openClawStateDatabaseCache,
  requireOpenClawStateDatabaseIdentity,
} from "./openclaw-state-db-cache.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
  OpenClawStateSchemaReadAdmission,
} from "./openclaw-state-db-contract.js";
import { isStatePostgres } from "./openclaw-state-db-engine.js";
import { withOpenClawStateReadOnlyLocation } from "./openclaw-state-db-read-connection.js";
import { ensureAgentDatabaseLeaseSchema } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import type { OpenClawStateLeaseContext } from "./openclaw-state-lease-context.js";

const log = createSubsystemLogger("state/agent-db");

type AgentDatabaseLeaseDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "agent_database_leases" | "agent_deletion_journal" | "state_leases"
>;

export const AGENT_DATABASE_MAINTENANCE_LEASE = {
  scope: "core:agent-database-maintenance",
  key: "global",
} as const;

export class OpenClawAgentDatabaseLeaseActiveError extends Error {
  constructor(
    message: string,
    /** Live owner PIDs observed by a read-only check; diagnostic evidence, never authority. */
    readonly ownerPids: readonly number[] = [],
  ) {
    super(message);
    this.name = "OpenClawAgentDatabaseLeaseActiveError";
  }
}

/** Ordinary agent worker routing cannot borrow native maintenance authority. */
export function hasAgentDatabaseMaintenanceAuthority(): boolean {
  return maintenanceAuthority.getStore() !== undefined;
}

export function runWithAgentDatabaseMaintenanceAuthority<T>(
  authority: OpenClawStateLeaseContext,
  databasePath: string,
  run: () => Promise<T>,
): Promise<T> {
  const scope = getOpenClawDatabaseMaintenanceScope();
  return maintenanceAuthority.run(
    {
      authority,
      databasePath: path.resolve(databasePath),
      assertScopeCurrent: scope ? () => scope.assertAdmission() : undefined,
    },
    run,
  );
}

/** Revalidate a maintenance owner when present, without requiring ordinary opens to hold one. */
export function assertAgentDatabaseMaintenanceAuthorityIfPresent(): void {
  maintenanceAuthority.getStore()?.assertScopeCurrent?.();
  maintenanceAuthority.getStore()?.authority.assertOwned();
}

/** Raw maintenance writers revoke admitted facts before changing stored bytes. */
export function invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(pathname: string): void {
  maintenanceAuthority.getStore()?.authority.assertOwned();
  invalidateOpenClawAgentDatabaseValidation(pathname);
  revokeSqliteDatabaseAdmissionsForPath(pathname);
}

/** Verify the maintenance owner and its independent heartbeat before a synchronous phase. */
export function renewAgentDatabaseMaintenanceAuthorityIfPresent(): void {
  const authority = maintenanceAuthority.getStore()?.authority;
  if (!authority) {
    return;
  }
  if (!authority.renew) {
    throw new Error("Agent database maintenance authority cannot renew its lease.");
  }
  authority.renew();
}

export type OpenClawAgentIntegrityVerificationReceiver = (
  canReuseRuntimeIntegrity: boolean,
  invalidated: boolean,
  because?: string,
) => void;

export function claimOpenClawAgentDatabaseLease(
  params: { agentId: string; path: string; env?: NodeJS.ProcessEnv },
  leaseId: string = randomUUID(),
  onVerification?: OpenClawAgentIntegrityVerificationReceiver,
): string {
  const agentId = normalizeAgentId(params.agentId);
  const deletionFence = prepareAgentDeletionPathFence(
    { agentId, path: params.path },
    { env: params.env },
  );
  const ownerStartTime = getFileLockProcessStartTime(process.pid);
  runOpenClawStateWriteTransaction(
    (database) =>
      claimAgentDatabaseLeaseInDatabase(
        database,
        {
          leaseId,
          agentId,
          path: params.path,
          ownerPid: process.pid,
          ownerStartTime,
          provenance: readAgentDatabaseLeaseProvenance(params.path),
        },
        deletionFence,
        onVerification,
      ),
    { env: params.env, initializationAgentPaths: [params.path] },
  );
  return leaseId;
}

function claimAgentDatabaseLeaseInDatabase(
  database: OpenClawStateDatabase,
  owner: Pick<
    OpenClawAgentDatabaseWorkerLeaseReceipt,
    "leaseId" | "agentId" | "path" | "ownerPid" | "ownerStartTime"
  > & { provenance: string | null },
  deletionFence: ReturnType<typeof prepareAgentDeletionPathFence>,
  onVerification?: OpenClawAgentIntegrityVerificationReceiver,
): void {
  ensureAgentDatabaseLeaseSchema(database.db);
  const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
  const maintenance = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("state_leases")
      .select("owner")
      .where("scope", "=", AGENT_DATABASE_MAINTENANCE_LEASE.scope)
      .where("lease_key", "=", AGENT_DATABASE_MAINTENANCE_LEASE.key)
      .where("expires_at", ">", Date.now()),
  );
  const authority = maintenanceAuthority.getStore();
  if (maintenance || authority) {
    throw new Error(
      "Agent database maintenance is in progress; retry after openclaw doctor --fix completes.",
    );
  }
  assertAgentDeletionPathFence(database, deletionFence);
  let invalidated = false;
  let hasOtherOwner = false;
  let processDeathRefusal: string | undefined;
  for (const held of readAgentDatabaseLeases(database.db)) {
    const sharesFile = mayShareAgentDatabaseFile(held.path, owner.path);
    const staleReason = sharesFile ? agentDatabaseLeaseStaleReason(held) : undefined;
    if (staleReason) {
      const because = agentDatabaseLeaseProcessDeathRefusal(held, owner.path, staleReason);
      processDeathRefusal ??= because;
      log.info(`agent database stale lease: ${staleReason}; previous release not observed`, {
        agentId: held.agent_id,
        leaseId: held.lease_id,
        path: held.path,
        staleReason,
        ownerPid: held.owner_pid,
        ownerStartTime: held.owner_start_time,
        because: because ?? "same-boot-dead-owner",
      });
      clearAgentDatabaseLeaseVerifications(database.db, held.path);
      invalidated = true;
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("agent_database_leases").where("lease_id", "=", held.lease_id),
      );
    } else if (
      sharesFile &&
      held.lease_id !== owner.leaseId &&
      (owner.ownerStartTime === null ||
        held.owner_pid !== owner.ownerPid ||
        held.owner_start_time === null ||
        held.owner_start_time !== owner.ownerStartTime)
    ) {
      hasOtherOwner = true;
    }
  }
  onVerification?.(
    !hasOtherOwner,
    invalidated,
    processDeathRefusal ?? (hasOtherOwner ? "live-or-unknown-owner" : undefined),
  );
  executeSqliteQuerySync(
    database.db,
    db.insertInto("agent_database_leases").values({
      lease_id: owner.leaseId,
      provenance: owner.provenance,
      agent_id: owner.agentId,
      path: owner.path,
      owner_pid: owner.ownerPid,
      owner_start_time: owner.ownerStartTime,
      opened_at: 0, // A killed, unfinished admission cannot lend process-death provenance.
    }),
  );
}

export function releaseOpenClawAgentDatabaseLease(
  leaseId: string,
  options: OpenClawStateDatabaseOptions = {},
  closeOutcome?:
    | { path: string; publishSeal: () => boolean }
    | "read-only"
    | "uncheckpointed"
    | "postgres-closed",
): void {
  const release = (database: EngineConnection) => {
    const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database);
    const held = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("agent_database_leases")
        .select(["path", "agent_id"])
        .where("lease_id", "=", leaseId),
    );
    if (held && !closeOutcome) {
      clearAgentDatabaseLeaseVerifications(database, held.path);
    }
    executeSqliteQuerySync(
      database,
      db.deleteFrom("agent_database_leases").where("lease_id", "=", leaseId),
    );
    let receipt: string;
    if (!held) {
      receipt = "lease-not-held";
    } else if (typeof closeOutcome !== "object") {
      receipt =
        closeOutcome === "uncheckpointed"
          ? "checkpoint-incomplete"
          : (closeOutcome ?? "close-unconfirmed");
    } else if (held.path !== closeOutcome.path) {
      receipt = "path-mismatch";
    } else if (hasAgentDatabasePathLease(database, closeOutcome.path)) {
      receipt = "active-leases";
    } else {
      // Shared-state writer admission excludes a competing claim until this release commits.
      receipt = closeOutcome.publishSeal() ? "written" : "verification-missing";
    }
    const publish = () =>
      log.info(
        `agent database clean-close receipt: ${receipt}; agent=${held?.agent_id ?? "unknown"}`,
        {
          agentId: held?.agent_id,
          path: held?.path,
          leaseId,
          receipt,
        },
      );
    if (!deferSqlitePostCommitPublication(database, publish)) {
      publish();
    }
  };
  const maintenance = maintenanceAuthority.getStore();
  const databasePath = path.resolve(
    options.database?.path ?? options.path ?? resolveOpenClawStateSqlitePath(options.env),
  );
  if (maintenance?.databasePath === databasePath) {
    return withExistingAgentLeaseWrite(maintenance.authority, options, release);
  }
  runOpenClawStateWriteTransaction(
    (database) => {
      ensureAgentDatabaseLeaseSchema(database.db);
      release(database.db);
    },
    typeof closeOutcome === "object"
      ? {
          ...options,
          initializationAgentPaths: [
            ...(options.initializationAgentPaths ?? []),
            closeOutcome.path,
          ],
        }
      : options,
  );
}

function agentDatabaseLeasePaths(database: EngineConnection): string[] {
  const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database);
  return executeSqliteQuerySync(
    database,
    db.selectFrom("agent_database_leases").select("path").distinct(),
  ).rows.map((row) => row.path);
}

function hasAgentDatabasePathLease(database: EngineConnection, pathname: string): boolean {
  return agentDatabaseLeasePaths(database).some((held) =>
    mayShareAgentDatabaseFile(held, pathname),
  );
}

/** Record that the claimed native owner completed its admission. */
export function recordOpenClawAgentDatabaseAdmission(
  leaseId: string,
  params: { agentId: string; path: string; env?: NodeJS.ProcessEnv },
): void {
  runOpenClawStateWriteTransaction(
    (database) => {
      ensureOpenClawQuarantineStore(params.env ?? process.env);
      const completed = executeSqliteQuerySync(
        database.db,
        getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db)
          .updateTable("agent_database_leases")
          .set({ opened_at: Date.now() })
          .where("lease_id", "=", leaseId)
          .where("agent_id", "=", params.agentId)
          .where("path", "=", params.path)
          .where("owner_pid", "=", process.pid),
      );
      if (completed.numAffectedRows !== 1n) {
        throw new Error(`Agent database open lost its runtime lease: ${params.path}`);
      }
    },
    { env: params.env },
    { singleStatement: true },
  );
}

function clearAgentDatabaseLeaseVerifications(database: EngineConnection, pathname: string): void {
  for (const held of new Set([pathname, ...agentDatabaseLeasePaths(database)])) {
    if (mayShareAgentDatabaseFile(held, pathname)) {
      invalidateOpenClawAgentDatabaseValidation(held);
      revokeSqliteDatabaseAdmissionsForPath(held);
    }
  }
}

/** An awaited open may consume its scan only while its original runtime claim survives. */
export function assertOpenClawAgentDatabaseLease(
  leaseId: string,
  params: { agentId: string; path: string; env?: NodeJS.ProcessEnv },
): void {
  readOpenClawAgentDatabaseLeaseClaim(leaseId, params);
}

function readOpenClawAgentDatabaseLeaseClaim(
  leaseId: string,
  params: { agentId: string; path: string; env?: NodeJS.ProcessEnv },
) {
  const ownerStartTime = getFileLockProcessStartTime(process.pid);
  const database = openOpenClawStateDatabase({
    env: params.env,
    initializationAgentPaths: [params.path],
  });
  const held = readAgentDatabaseLeases(database.db, leaseId)[0];
  if (
    !held ||
    held.agent_id !== params.agentId ||
    held.path !== params.path ||
    held.owner_pid !== process.pid ||
    // Claims allow an unavailable start identity; only two known identities prove reuse.
    (held.owner_start_time !== null &&
      ownerStartTime !== null &&
      held.owner_start_time !== ownerStartTime)
  ) {
    throw new Error(`Agent database open lost its runtime lease: ${params.path}`);
  }
  return { database, held };
}

export type OpenClawAgentDatabaseWorkerLeaseReceipt = ReturnType<
  typeof readOpenClawAgentDatabaseWorkerLeaseReceiptFromClaim
>;

/** Preparation grants no access; claim repeats admission on the captured shared owner. */
export function prepareOpenClawAgentDatabaseWorkerLease(
  params: { agentId: string; path: string; env?: NodeJS.ProcessEnv },
  sharedDatabase: OpenClawStateDatabase,
  leaseId: string,
): {
  receipt: OpenClawAgentDatabaseWorkerLeaseReceipt;
  provenance: string | null;
  validation?: OpenClawAgentDatabaseValidation;
  integrityRevoked?: boolean;
  startupRepair?: (
    check: SqliteIntegrityCheck,
    error: unknown,
    assertCurrent: () => void,
  ) => boolean;
  claim(onVerification?: OpenClawAgentIntegrityVerificationReceiver): string;
} {
  const database = { ...sharedDatabase };
  const identity = requireOpenClawStateDatabaseIdentity(database);
  const assertCurrent = () => {
    if (!database.db.isOpen || requireOpenClawStateDatabaseIdentity(database) !== identity) {
      throw new Error("Prepared agent database lease lost its original shared owner");
    }
  };
  assertCurrent();
  const ownerPid = process.pid;
  const provenance = readAgentDatabaseLeaseProvenance(params.path);
  const receipt = Object.freeze({
    leaseId,
    agentId: normalizeAgentId(params.agentId),
    path: path.resolve(params.path),
    ownerPid,
    ownerStartTime: getFileLockProcessStartTime(ownerPid),
    sharedStatePath: database.path,
    sharedStateIdentity: identity.key,
  });
  const options = {
    database,
    path: database.path,
    env: { ...(params.env ?? process.env) },
  };
  return {
    receipt,
    provenance,
    claim(onVerification) {
      assertCurrent();
      const deletionFence = prepareAgentDeletionPathFence(
        { agentId: receipt.agentId, path: receipt.path },
        options,
      );
      try {
        runOpenClawStateWriteTransaction((current) => {
          assertCurrent();
          claimAgentDatabaseLeaseInDatabase(
            current,
            { ...receipt, provenance },
            deletionFence,
            onVerification,
          );
        }, options);
      } catch (error) {
        if (error instanceof AgentDatabaseDeletionRefusedError) {
          throw new SqliteWorkerOpenRefusedError(error);
        }
        throw error;
      }
      return receipt.leaseId;
    },
  };
}

/** Capture the exact admitted claim so its parent can finish cleanup after native Worker exit. */
export function readOpenClawAgentDatabaseWorkerLeaseReceiptFromClaim(
  leaseId: string,
  params: { agentId: string; path: string; env?: NodeJS.ProcessEnv },
) {
  const { database, held } = readOpenClawAgentDatabaseLeaseClaim(leaseId, params);
  return {
    leaseId,
    agentId: held.agent_id,
    path: held.path,
    ownerPid: held.owner_pid,
    ownerStartTime: held.owner_start_time,
    sharedStatePath: database.path,
    sharedStateIdentity: readDatabasePathIdentitySync(database.path).key,
  };
}

/** The caller owns the original shared transaction and has joined the exact native Worker exit. */
export function releaseExitedOpenClawAgentDatabaseLeaseInDatabase(
  database: EngineConnection,
  receipt: OpenClawAgentDatabaseWorkerLeaseReceipt,
  onInvalidation?: () => void,
): void {
  const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database);
  const row = readAgentDatabaseLeases(database, receipt.leaseId)[0];
  if (!row) {
    return;
  }
  if (
    row.agent_id !== receipt.agentId ||
    row.path !== receipt.path ||
    row.owner_pid !== receipt.ownerPid ||
    row.owner_start_time !== receipt.ownerStartTime
  ) {
    throw new Error("SQLite reclamation Worker lease cleanup receipt no longer matches");
  }
  onInvalidation?.();
  clearAgentDatabaseLeaseVerifications(database, receipt.path);
  executeSqliteQuerySync(
    database,
    db.deleteFrom("agent_database_leases").where("lease_id", "=", receipt.leaseId),
  );
}

function readAgentDatabaseLeases(database: EngineConnection, leaseId?: string) {
  const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database);
  const query = db.selectFrom("agent_database_leases").selectAll();
  return executeSqliteQuerySync(
    database,
    leaseId === undefined ? query : query.where("lease_id", "=", leaseId),
  ).rows;
}

/** Read-only diagnostic observation; an empty result never grants maintenance authority. */
export function readActiveOpenClawAgentDatabaseLeasesReadOnly(
  options: OpenClawStateDatabaseOptions = {},
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission,
): ReturnType<typeof readAgentDatabaseLeases> {
  const pathname = path.resolve(options.path ?? resolveOpenClawStateSqlitePath(options.env));
  try {
    fs.statSync(pathname);
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
  const readActiveLeases = (db: EngineConnection) => {
    const read = () => {
      if (!tableExists(db, "agent_database_leases")) {
        return [];
      }
      return readAgentDatabaseLeases(db).filter((row) => !agentDatabaseLeaseStaleReason(row));
    };
    return isPostgresSqlConnection(db) ? read() : runWithSqliteBusyTimeout(db, 250, read);
  };
  if (!cached) {
    return withOpenClawStateReadOnlyLocation(
      ({ db }) => readActiveLeases(db),
      pathname,
      isStatePostgres() ? pathname : prepareSqliteReadOnlyLocationSync(pathname),
      openStateSchemaReadAdmission,
    );
  }
  const closeSchemaReadAdmission =
    !isPostgresSqlConnection(cached.db) && openStateSchemaReadAdmission
      ? openStateSchemaReadAdmission(cached.db)
      : undefined;
  try {
    return readActiveLeases(cached.db);
  } finally {
    closeSchemaReadAdmission?.();
  }
}

/** Doctor holds both lifecycle coordinators before checking writers, without schema repair. */
export function assertNoOpenClawAgentDatabaseLeasesReadOnly(
  options: OpenClawStateDatabaseOptions = {},
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission,
): void {
  const owners = readActiveOpenClawAgentDatabaseLeasesReadOnly(
    options,
    openStateSchemaReadAdmission,
  );
  const [owner] = owners;
  if (owner) {
    throw new OpenClawAgentDatabaseLeaseActiveError(
      `Agent ${owner.agent_id} database is still open in process ${owner.owner_pid}; stop that process before Doctor repair.`,
      [...new Set(owners.map((row) => row.owner_pid))],
    );
  }
}

export function assertNoOpenClawAgentDatabaseLeases(
  agentIdRaw: string | OpenClawStateLeaseContext,
  options: OpenClawStateDatabaseOptions & { schemaPolicy?: "existing" } = {},
): void {
  if (options.schemaPolicy === "existing") {
    if (typeof agentIdRaw === "string") {
      throw new Error("Existing-schema agent drainage requires a real maintenance owner.");
    }
    return assertNoExistingAgentDatabaseLeases(agentIdRaw, options);
  }
  const maintenance = typeof agentIdRaw === "string" ? undefined : agentIdRaw;
  const agentId = typeof agentIdRaw === "string" ? normalizeAgentId(agentIdRaw) : undefined;
  runOpenClawStateWriteTransaction((database) => {
    maintenance?.assertOwnedInTransaction(database.db);
    ensureAgentDatabaseLeaseSchema(database.db);
    const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
    for (const row of readAgentDatabaseLeases(database.db)) {
      if (agentDatabaseLeaseStaleReason(row)) {
        clearAgentDatabaseLeaseVerifications(database.db, row.path);
        executeSqliteQuerySync(
          database.db,
          db.deleteFrom("agent_database_leases").where("lease_id", "=", row.lease_id),
        );
        continue;
      }
      if (!agentId || row.agent_id === agentId) {
        const remediation = agentId ? "." : "; stop that process and rerun openclaw doctor --fix.";
        throw new OpenClawAgentDatabaseLeaseActiveError(
          `Agent ${row.agent_id} database is still open in another process${remediation}`,
        );
      }
      assertAgentDeletionPathFence(
        database,
        prepareAgentDeletionPathFence(
          { agentId: row.agent_id, path: row.path, fenceAgentId: agentId },
          options,
        ),
      );
    }
  }, options);
}

/** Stable existing rows can be drained before the candidate is allowed to migrate. */
function assertNoExistingAgentDatabaseLeases(
  maintenance: OpenClawStateLeaseContext,
  options: OpenClawStateDatabaseOptions,
): void {
  withExistingAgentLeaseWrite(maintenance, options, (db) => {
    const query = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(db);
    for (const row of readAgentDatabaseLeases(db)) {
      if (agentDatabaseLeaseStaleReason(row)) {
        clearAgentDatabaseLeaseVerifications(db, row.path);
        executeSqliteQuerySync(
          db,
          query.deleteFrom("agent_database_leases").where("lease_id", "=", row.lease_id),
        );
      } else {
        throw new OpenClawAgentDatabaseLeaseActiveError(
          `Agent ${row.agent_id} database is still open in another process; stop that process and retry.`,
        );
      }
    }
  });
}
