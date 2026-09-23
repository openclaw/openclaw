import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { hasErrnoCode } from "../infra/errno.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { prepareSqliteReadOnlyLocationSync } from "../infra/sqlite-snapshot-source.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import {
  assertAgentDeletionPathFence,
  prepareAgentDeletionPathFence,
} from "./agent-deletion-journal.js";
import { withExistingAgentLeaseWrite } from "./openclaw-agent-db-existing-write.js";
import type { OpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-cache.js";
import {
  readOpenClawAgentIntegrityVerification,
  markOpenClawAgentIntegrityClean,
  clearOpenClawAgentIntegrityVerification,
  recordOpenClawAgentIntegrityVerification,
  type OpenClawAgentIntegrityVerification,
} from "./openclaw-quarantine-store.js";
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
import { withOpenClawStateReadOnlyLocation } from "./openclaw-state-db-read-connection.js";
import { ensureAgentDatabaseLeaseSchema } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  resolveOpenClawStateSqlitePath,
  resolveOpenClawStateDirForDatabasePath,
} from "./openclaw-state-db.paths.js";
import type { OpenClawStateLeaseContext } from "./openclaw-state-lease-context.js";

type AgentDatabaseLeaseDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "agent_database_leases" | "agent_deletion_journal" | "state_leases"
>;

export const AGENT_DATABASE_MAINTENANCE_LEASE = {
  scope: "core:agent-database-maintenance",
  key: "global",
} as const;

export class OpenClawAgentDatabaseLeaseActiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenClawAgentDatabaseLeaseActiveError";
  }
}

const maintenanceAuthority = new AsyncLocalStorage<{
  authority: OpenClawStateLeaseContext;
  databasePath: string;
  assertScopeCurrent?: () => void;
}>();

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

/** Revalidate the held lease, including immediately before committing a versioned rebuild. */
export function assertAgentDatabaseMaintenanceAuthority(
  expected?: OpenClawStateLeaseContext,
): void {
  const authority = maintenanceAuthority.getStore()?.authority;
  if (!authority || (expected && authority !== expected)) {
    throw new Error(
      "Agent identity migration requires stopped-writer maintenance; stop active agents and run openclaw doctor --fix.",
    );
  }
  authority.assertOwned();
  maintenanceAuthority.getStore()?.assertScopeCurrent?.();
}

/** Revalidate a maintenance owner when present, without requiring ordinary opens to hold one. */
export function assertAgentDatabaseMaintenanceAuthorityIfPresent(): void {
  maintenanceAuthority.getStore()?.assertScopeCurrent?.();
  maintenanceAuthority.getStore()?.authority.assertOwned();
}

/** Raw maintenance writers share the captured state owner, including explicit-env Doctor runs. */
export function invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(
  pathname: string,
  env?: NodeJS.ProcessEnv,
): void {
  const maintenance = maintenanceAuthority.getStore();
  maintenance?.authority.assertOwned();
  clearOpenClawAgentIntegrityVerification(
    pathname,
    maintenance
      ? { OPENCLAW_STATE_DIR: resolveOpenClawStateDirForDatabasePath(maintenance.databasePath) }
      : env,
  );
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
  record: OpenClawAgentIntegrityVerification | undefined,
  hasLiveLease: boolean,
  invalidated: boolean,
) => void;

export function claimOpenClawAgentDatabaseLease(
  params: { agentId: string; path: string; env?: NodeJS.ProcessEnv },
  leaseId: string = crypto.randomUUID(),
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
        { leaseId, agentId, path: params.path, ownerPid: process.pid, ownerStartTime },
        deletionFence,
        params.env,
        onVerification,
      ),
    { env: params.env },
  );
  return leaseId;
}

function claimAgentDatabaseLeaseInDatabase(
  database: OpenClawStateDatabase,
  owner: Pick<
    OpenClawAgentDatabaseWorkerLeaseReceipt,
    "leaseId" | "agentId" | "path" | "ownerPid" | "ownerStartTime"
  >,
  deletionFence: ReturnType<typeof prepareAgentDeletionPathFence>,
  env?: NodeJS.ProcessEnv,
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
  for (const held of readAgentDatabaseLeases(database.db)) {
    if (mayShareAgentDatabaseFile(held.path, owner.path) && isAgentDatabaseLeaseStale(held)) {
      clearAgentDatabaseLeaseVerifications(database.db, held.path, env);
      invalidated = true;
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("agent_database_leases").where("lease_id", "=", held.lease_id),
      );
    }
  }
  // Receipt publication and lease deletion use separate SQLite files. An
  // unfinished release must not lend a clean receipt to a competing opener.
  const hasLiveLease = hasAgentDatabasePathLease(database.db, owner.path);
  const hasOtherOwner = hasAgentDatabasePathLease(database.db, owner.path, owner);
  const verification = readOpenClawAgentIntegrityVerification(
    owner.path,
    env,
    !hasLiveLease || hasOtherOwner,
  );
  onVerification?.(
    verification && hasLiveLease ? { ...verification, clean_close: 0 } : verification,
    hasLiveLease && !hasOtherOwner,
    invalidated,
  );
  executeSqliteQuerySync(
    database.db,
    db.insertInto("agent_database_leases").values({
      lease_id: owner.leaseId,
      agent_id: owner.agentId,
      path: owner.path,
      owner_pid: owner.ownerPid,
      owner_start_time: owner.ownerStartTime,
      opened_at: Date.now(),
    }),
  );
}

export function releaseOpenClawAgentDatabaseLease(
  leaseId: string,
  options: OpenClawStateDatabaseOptions = {},
  closeOutcome?: { path: string; identity: string } | "read-only" | "uncheckpointed",
): void {
  const release = (database: DatabaseSync) => {
    const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database);
    const held = executeSqliteQueryTakeFirstSync(
      database,
      db.selectFrom("agent_database_leases").select("path").where("lease_id", "=", leaseId),
    );
    if (held && (!closeOutcome || closeOutcome === "uncheckpointed")) {
      clearAgentDatabaseLeaseVerifications(
        database,
        held.path,
        options.env,
        closeOutcome === "uncheckpointed" ? "retain" : "revoke",
      );
    }
    executeSqliteQuerySync(
      database,
      db.deleteFrom("agent_database_leases").where("lease_id", "=", leaseId),
    );
    if (
      typeof closeOutcome === "object" &&
      held?.path === closeOutcome.path &&
      !hasAgentDatabasePathLease(database, closeOutcome.path)
    ) {
      markOpenClawAgentIntegrityClean(
        closeOutcome.path,
        options.env ?? process.env,
        closeOutcome.identity,
      );
    }
  };
  const maintenance = maintenanceAuthority.getStore();
  const databasePath = path.resolve(
    options.database?.path ?? options.path ?? resolveOpenClawStateSqlitePath(options.env),
  );
  if (maintenance?.databasePath === databasePath) {
    return withExistingAgentLeaseWrite(maintenance.authority, options, release);
  }
  runOpenClawStateWriteTransaction((database) => {
    ensureAgentDatabaseLeaseSchema(database.db);
    release(database.db);
  }, options);
}

type AgentDatabaseLeaseOwner = Pick<
  OpenClawAgentDatabaseWorkerLeaseReceipt,
  "leaseId" | "ownerPid" | "ownerStartTime"
>;

function agentDatabaseLeasePaths(
  database: DatabaseSync,
  excludedOwner?: AgentDatabaseLeaseOwner,
): string[] {
  const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database);
  let query = db.selectFrom("agent_database_leases").select("path").distinct();
  if (excludedOwner) {
    query = query.where("lease_id", "!=", excludedOwner.leaseId);
    if (excludedOwner.ownerStartTime !== null) {
      query = query.where((eb) =>
        eb.or([
          eb("owner_pid", "!=", excludedOwner.ownerPid),
          eb("owner_start_time", "is", null),
          eb("owner_start_time", "!=", excludedOwner.ownerStartTime),
        ]),
      );
    }
  }
  return executeSqliteQuerySync(database, query).rows.map((row) => row.path);
}

function mayShareAgentDatabaseFile(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  try {
    const first = fs.statSync(left, { bigint: true, throwIfNoEntry: false });
    const second = fs.statSync(right, { bigint: true, throwIfNoEntry: false });
    return !first || !second || (first.dev === second.dev && first.ino === second.ino);
  } catch {
    // An inaccessible or replaced lease path cannot prove exclusive ownership.
    return true;
  }
}

function hasAgentDatabasePathLease(
  database: DatabaseSync,
  pathname: string,
  excludedOwner?: AgentDatabaseLeaseOwner,
): boolean {
  return agentDatabaseLeasePaths(database, excludedOwner).some((held) =>
    mayShareAgentDatabaseFile(held, pathname),
  );
}

/** Peer handles in one known process share integrity ownership, but retain separate close leases. */
export function recordOpenClawAgentDatabaseIntegrityVerified(
  leaseId: string,
  params: { agentId: string; path: string; env?: NodeJS.ProcessEnv },
  identity: string,
): void {
  runOpenClawStateWriteTransaction(
    (database) => {
      assertOpenClawAgentDatabaseLease(leaseId, params);
      if (
        !hasAgentDatabasePathLease(database.db, params.path, {
          leaseId,
          ownerPid: process.pid,
          ownerStartTime: getFileLockProcessStartTime(process.pid),
        })
      ) {
        recordOpenClawAgentIntegrityVerification(params.path, params.env ?? process.env, identity);
      }
    },
    { env: params.env },
  );
}

function clearAgentDatabaseLeaseVerifications(
  database: DatabaseSync,
  pathname: string,
  env: NodeJS.ProcessEnv = process.env,
  runtimeProof: "revoke" | "retain" = "revoke",
): void {
  for (const held of new Set([pathname, ...agentDatabaseLeasePaths(database)])) {
    if (mayShareAgentDatabaseFile(held, pathname)) {
      clearOpenClawAgentIntegrityVerification(held, env, runtimeProof);
    }
  }
}

/** An awaited open may consume its scan only while its original runtime claim survives. */
export function assertOpenClawAgentDatabaseLease(
  leaseId: string,
  params: { agentId: string; path: string; env?: NodeJS.ProcessEnv },
): void {
  const ownerStartTime = getFileLockProcessStartTime(process.pid);
  const database = openOpenClawStateDatabase({ env: params.env });
  const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
  const held = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("agent_database_leases")
      .select(["agent_id", "path", "owner_pid", "owner_start_time"])
      .where("lease_id", "=", leaseId),
  );
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
}

export type OpenClawAgentDatabaseWorkerLeaseReceipt = {
  leaseId: string;
  agentId: string;
  path: string;
  ownerPid: number;
  ownerStartTime: number | null;
  sharedStatePath: string;
  sharedStateIdentity: string;
};

/** Preparation grants no access; claim repeats admission on the captured shared owner. */
export function prepareOpenClawAgentDatabaseWorkerLease(
  params: { agentId: string; path: string; env?: NodeJS.ProcessEnv },
  sharedDatabase: OpenClawStateDatabase,
  leaseId: string,
): {
  receipt: OpenClawAgentDatabaseWorkerLeaseReceipt;
  validation?: OpenClawAgentDatabaseValidation;
  claim(onVerification?: OpenClawAgentIntegrityVerificationReceiver): string;
} {
  const database = {
    db: sharedDatabase.db,
    path: sharedDatabase.path,
    walMaintenance: sharedDatabase.walMaintenance,
  };
  const identity = requireOpenClawStateDatabaseIdentity(database);
  const assertCurrent = () => {
    if (!database.db.isOpen || requireOpenClawStateDatabaseIdentity(database) !== identity) {
      throw new Error("Prepared agent database lease lost its original shared owner");
    }
  };
  assertCurrent();
  const ownerPid = process.pid;
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
    claim(onVerification) {
      assertCurrent();
      const deletionFence = prepareAgentDeletionPathFence(
        { agentId: receipt.agentId, path: receipt.path },
        options,
      );
      runOpenClawStateWriteTransaction((current) => {
        assertCurrent();
        claimAgentDatabaseLeaseInDatabase(
          current,
          receipt,
          deletionFence,
          options.env,
          onVerification,
        );
      }, options);
      return receipt.leaseId;
    },
  };
}

/** Capture the exact admitted claim so its parent can finish cleanup after native Worker exit. */
export function readOpenClawAgentDatabaseWorkerLeaseReceiptFromClaim(
  leaseId: string,
  params: { agentId: string; path: string; env?: NodeJS.ProcessEnv },
): OpenClawAgentDatabaseWorkerLeaseReceipt {
  assertOpenClawAgentDatabaseLease(leaseId, params);
  const database = openOpenClawStateDatabase({ env: params.env });
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db)
      .selectFrom("agent_database_leases")
      .select(["agent_id", "path", "owner_pid", "owner_start_time"])
      .where("lease_id", "=", leaseId),
  );
  if (!row) {
    throw new Error("SQLite reclamation Worker lost its admitted lease receipt");
  }
  return {
    leaseId,
    agentId: row.agent_id,
    path: row.path,
    ownerPid: row.owner_pid,
    ownerStartTime: row.owner_start_time,
    sharedStatePath: database.path,
    sharedStateIdentity: readDatabasePathIdentitySync(database.path).key,
  };
}

/** The caller owns the original shared transaction and has joined the exact native Worker exit. */
export function releaseExitedOpenClawAgentDatabaseLeaseInDatabase(
  database: DatabaseSync,
  receipt: OpenClawAgentDatabaseWorkerLeaseReceipt,
  onInvalidation?: () => void,
): void {
  const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("agent_database_leases")
      .select(["agent_id", "path", "owner_pid", "owner_start_time"])
      .where("lease_id", "=", receipt.leaseId),
  );
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
  clearAgentDatabaseLeaseVerifications(database, receipt.path, {
    OPENCLAW_STATE_DIR: resolveOpenClawStateDirForDatabasePath(receipt.sharedStatePath),
  });
  executeSqliteQuerySync(
    database,
    db.deleteFrom("agent_database_leases").where("lease_id", "=", receipt.leaseId),
  );
}

function readAgentDatabaseLeases(database: DatabaseSync) {
  const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database);
  return executeSqliteQuerySync(
    database,
    db
      .selectFrom("agent_database_leases")
      .select(["agent_id", "lease_id", "owner_pid", "owner_start_time", "path"]),
  ).rows;
}

function isAgentDatabaseLeaseStale(row: {
  owner_pid: number;
  owner_start_time: number | null;
}): boolean {
  if (isPidDefinitelyDead(row.owner_pid)) {
    return true;
  }
  const currentStartTime = getFileLockProcessStartTime(row.owner_pid);
  return (
    row.owner_start_time !== null &&
    currentStartTime !== null &&
    row.owner_start_time !== currentStartTime
  );
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
  const readActiveLeases = (db: DatabaseSync) =>
    runWithSqliteBusyTimeout(db, 250, () => {
      if (!tableExists(db, "agent_database_leases")) {
        return [];
      }
      return readAgentDatabaseLeases(db).filter((row) => !isAgentDatabaseLeaseStale(row));
    });
  if (!cached) {
    return withOpenClawStateReadOnlyLocation(
      ({ db }) => readActiveLeases(db),
      pathname,
      prepareSqliteReadOnlyLocationSync(pathname),
      openStateSchemaReadAdmission,
    );
  }
  const closeSchemaReadAdmission = openStateSchemaReadAdmission?.(cached.db);
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
  const [owner] = readActiveOpenClawAgentDatabaseLeasesReadOnly(
    options,
    openStateSchemaReadAdmission,
  );
  if (owner) {
    throw new OpenClawAgentDatabaseLeaseActiveError(
      `Agent ${owner.agent_id} database is still open in process ${owner.owner_pid}; stop that process before Doctor repair.`,
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
  const rows = runOpenClawStateWriteTransaction((database) => {
    maintenance?.assertOwnedInTransaction(database.db);
    ensureAgentDatabaseLeaseSchema(database.db);
    return readAgentDatabaseLeases(database.db);
  }, options);

  const staleLeaseIds = rows.filter(isAgentDatabaseLeaseStale).map((row) => row.lease_id);
  if (staleLeaseIds.length > 0) {
    runOpenClawStateWriteTransaction((database) => {
      maintenance?.assertOwnedInTransaction(database.db);
      ensureAgentDatabaseLeaseSchema(database.db);
      const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
      for (const row of rows.filter((candidate) => staleLeaseIds.includes(candidate.lease_id))) {
        clearAgentDatabaseLeaseVerifications(database.db, row.path, options.env);
      }
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("agent_database_leases").where("lease_id", "in", staleLeaseIds),
      );
    }, options);
  }
  const staleLeaseIdSet = new Set(staleLeaseIds);
  for (const row of rows) {
    if (staleLeaseIdSet.has(row.lease_id)) {
      continue;
    }
    const deletionFence = agentId
      ? prepareAgentDeletionPathFence(
          { agentId: row.agent_id, path: row.path, fenceAgentId: agentId },
          options,
        )
      : undefined;
    let leaseStillExists = false;
    runOpenClawStateWriteTransaction((database) => {
      maintenance?.assertOwnedInTransaction(database.db);
      ensureAgentDatabaseLeaseSchema(database.db);
      const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
      leaseStillExists =
        executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("agent_database_leases")
            .select("lease_id")
            .where("lease_id", "=", row.lease_id),
        ) !== undefined;
      if (leaseStillExists && row.agent_id !== agentId && deletionFence) {
        assertAgentDeletionPathFence(database, deletionFence);
      }
    }, options);
    if (leaseStillExists && (!agentId || row.agent_id === agentId)) {
      const remediation = agentId ? "." : "; stop that process and rerun openclaw doctor --fix.";
      throw new OpenClawAgentDatabaseLeaseActiveError(
        `Agent ${row.agent_id} database is still open in another process${remediation}`,
      );
    }
  }
}

/** Stable existing rows can be drained before the candidate is allowed to migrate. */
function assertNoExistingAgentDatabaseLeases(
  maintenance: OpenClawStateLeaseContext,
  options: OpenClawStateDatabaseOptions,
): void {
  withExistingAgentLeaseWrite(maintenance, options, (db) => {
    const query = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(db);
    const rows = executeSqliteQuerySync(
      db,
      query
        .selectFrom("agent_database_leases")
        .select(["agent_id", "lease_id", "owner_pid", "owner_start_time", "path"]),
    ).rows;
    for (const row of rows) {
      const currentStart = getFileLockProcessStartTime(row.owner_pid);
      if (
        isPidDefinitelyDead(row.owner_pid) ||
        (row.owner_start_time !== null &&
          currentStart !== null &&
          row.owner_start_time !== currentStart)
      ) {
        clearAgentDatabaseLeaseVerifications(db, row.path, options.env);
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
