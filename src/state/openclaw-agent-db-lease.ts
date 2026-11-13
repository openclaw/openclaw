import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { LruCache } from "../infra/lru-cache.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import type { SqliteIntegrityCheck } from "../infra/sqlite-integrity.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { SqliteWorkerOpenRefusedError } from "../infra/sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import {
  AgentDatabaseDeletionRefusedError,
  assertAgentDeletionPathFence,
  prepareAgentDeletionPathFence,
} from "./agent-deletion-journal.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db-contract.js";
import { withExistingAgentLeaseWrite } from "./openclaw-agent-db-existing-write.js";
import {
  createAgentDatabaseLeaseStaleReasonReader,
  mayShareAgentDatabaseFile,
  readAgentDatabaseLeaseProvenance,
} from "./openclaw-agent-db-lease-provenance.js";
import { agentDatabaseMaintenanceAuthority as maintenanceAuthority } from "./openclaw-agent-db-maintenance-authority.js";
import {
  invalidateOpenClawAgentDatabaseValidation,
  type OpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import { ensureOpenClawQuarantineStore } from "./openclaw-quarantine-store.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { requireOpenClawStateDatabaseIdentity } from "./openclaw-state-db-cache.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import { ensureAgentDatabaseLeaseSchema } from "./openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import type { OpenClawStateLeaseContext } from "./openclaw-state-lease-context.js";

const log = createSubsystemLogger("state/agent-db");
// Diagnostic state survives handle churn, but never owns leases or suppresses seal checks.
const closeReceipts = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseCloseReceipts"),
  () => new LruCache<{ agentId: string; receipt: string; blockingLeaseId?: string }>(128),
  (receipts) => receipts.clear(),
);

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

export function readAgentDatabaseLeases(database: EngineConnection, leaseId?: string) {
  const db =
    getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "agent_database_leases">>(database);
  const query = db.selectFrom("agent_database_leases").selectAll();
  return executeSqliteQuerySync(
    database,
    leaseId === undefined ? query : query.where("lease_id", "=", leaseId),
  ).rows;
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
  liveOwnerProvenance?: string,
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
  let hasOtherOwner = false;
  let liveOwnerProvenance: string | undefined;
  const staleReasonFor = createAgentDatabaseLeaseStaleReasonReader();
  for (const held of readAgentDatabaseLeases(database.db)) {
    const sharesFile = mayShareAgentDatabaseFile(held.path, owner.path);
    const staleReason = sharesFile ? staleReasonFor(held) : undefined;
    if (staleReason) {
      log.info(`agent database stale lease: ${staleReason}; previous release not observed`, {
        agentId: held.agent_id,
        leaseId: held.lease_id,
        path: held.path,
        staleReason,
        ownerPid: held.owner_pid,
        ownerStartTime: held.owner_start_time,
      });
      // SQLite recovers interrupted WAL writes. A dead lease does not revoke this
      // process's admitted physical file or establish corruption in a cold opener.
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("agent_database_leases").where("lease_id", "=", held.lease_id),
      );
      reportPriorBootLeaseRelease(database.db, held.lease_id, staleReason);
    } else if (
      sharesFile &&
      held.lease_id !== owner.leaseId &&
      (owner.ownerStartTime === null ||
        held.owner_pid !== owner.ownerPid ||
        held.owner_start_time === null ||
        held.owner_start_time !== owner.ownerStartTime)
    ) {
      hasOtherOwner = true;
      // A live peer that finished admitting this same physical file already verified it; another
      // process rescanning it adds no protection and costs a full integrity_check per open.
      // Provenance binds boot, PID namespace, build and file inode, so a replaced path never borrows.
      if (
        held.path === owner.path &&
        held.provenance !== null &&
        held.provenance === owner.provenance &&
        held.opened_at > 0 &&
        held.owner_start_time !== null &&
        getFileLockProcessStartTime(held.owner_pid) === held.owner_start_time
      ) {
        liveOwnerProvenance = held.provenance;
      }
    }
  }
  onVerification?.(!hasOtherOwner, liveOwnerProvenance);
  executeSqliteQuerySync(
    database.db,
    db.insertInto("agent_database_leases").values({
      lease_id: owner.leaseId,
      provenance: owner.provenance,
      agent_id: owner.agentId,
      path: owner.path,
      owner_pid: owner.ownerPid,
      owner_start_time: owner.ownerStartTime,
      opened_at: 0, // A live, unfinished admission cannot lend verification.
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
  timing?: OpenClawAgentDatabase["closeTiming"],
): void {
  const leaseStartedAt = performance.now();
  const release = (database: EngineConnection) => {
    const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database);
    const held = executeSqliteQueryTakeFirstSync(
      database,
      closeOutcome === undefined
        ? db
            .selectFrom("agent_database_leases")
            .select(["path", "agent_id"])
            .where("lease_id", "=", leaseId)
        : db
            .deleteFrom("agent_database_leases")
            .where("lease_id", "=", leaseId)
            .returning(["path", "agent_id"]),
    );
    if (closeOutcome === undefined) {
      if (held) {
        clearAgentDatabaseLeaseVerifications(database, held.path);
      }
      executeSqliteQuerySync(
        database,
        db.deleteFrom("agent_database_leases").where("lease_id", "=", leaseId),
      );
    }
    let receipt: string;
    let blockingLease: ReturnType<typeof findAgentDatabasePathLease>;
    if (!held) {
      receipt = "lease-not-held";
    } else if (typeof closeOutcome !== "object") {
      receipt =
        closeOutcome === "uncheckpointed"
          ? "checkpoint-incomplete"
          : (closeOutcome ?? "close-unconfirmed");
    } else if (held.path !== closeOutcome.path) {
      receipt = "path-mismatch";
    } else {
      // Shared-state writer admission excludes a competing claim until this release commits.
      blockingLease = findAgentDatabasePathLease(database, closeOutcome.path);
      receipt = blockingLease
        ? "active-leases"
        : closeOutcome.publishSeal()
          ? "written"
          : "verification-missing";
    }
    const publish = () => {
      const totalMs = timing ? performance.now() - timing.startedAt : 0;
      const slowClose = totalMs >= 500;
      const phases = slowClose
        ? {
            totalMs: Math.round(totalMs),
            walStopMs: Math.round(timing?.walStopMs ?? 0),
            checkpointMs: Math.round(timing?.checkpointMs ?? 0),
            nativeCloseMs: Math.round(timing?.nativeCloseMs ?? 0),
            leaseReleaseMs: Math.round(performance.now() - leaseStartedAt),
          }
        : undefined;
      const dbHash = phases
        ? createHash("sha256")
            .update(held?.path ?? "unknown")
            .digest("hex")
            .slice(0, 16)
        : undefined;
      if (held) {
        const previous = closeReceipts.get(held.path);
        if (
          !slowClose &&
          previous?.agentId === held.agent_id &&
          previous.receipt === receipt &&
          previous.blockingLeaseId === blockingLease?.lease_id
        ) {
          return;
        }
        closeReceipts.set(held.path, {
          agentId: held.agent_id,
          receipt,
          blockingLeaseId: blockingLease?.lease_id,
        });
      }
      log.info(
        `agent database clean-close receipt: ${receipt}; agent=${held?.agent_id ?? "unknown"}${blockingLease ? `; blockingLeaseId=${blockingLease.lease_id}; ownerPid=${blockingLease.owner_pid}` : ""}${phases ? `; db=${dbHash}; thread=${threadId}; close=${JSON.stringify(phases)}` : ""}`,
        {
          agentId: held?.agent_id,
          path: held?.path,
          leaseId,
          receipt,
          ...(phases ? { close: phases } : {}),
          blockingLease: blockingLease && {
            leaseId: blockingLease.lease_id,
            ownerPid: blockingLease.owner_pid,
            ownerStartTime: blockingLease.owner_start_time,
            path: blockingLease.path,
            openedAt: blockingLease.opened_at,
          },
        },
      );
    };
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
  // Native handle disposal releases its lock after boot admission has ended.
  withEngineStoreAdmission(() =>
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
    ),
  );
}

function agentDatabaseLeasePaths(database: EngineConnection): string[] {
  const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database);
  return executeSqliteQuerySync(
    database,
    db.selectFrom("agent_database_leases").select("path").distinct(),
  ).rows.map((row) => row.path);
}

function findAgentDatabasePathLease(database: EngineConnection, pathname: string) {
  return readAgentDatabaseLeases(database).find((held) =>
    mayShareAgentDatabaseFile(held.path, pathname),
  );
}

/** Only a completed admission may lend its file-bound proof to another process. */
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
  startupIntegrityRequired?: boolean;
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
  outcome: "refused-before-open" | "unknown",
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
  if (outcome !== "refused-before-open") {
    onInvalidation?.();
    clearAgentDatabaseLeaseVerifications(database, receipt.path);
  }
  executeSqliteQuerySync(
    database,
    db.deleteFrom("agent_database_leases").where("lease_id", "=", receipt.leaseId),
  );
}

function reportPriorBootLeaseRelease(
  database: EngineConnection,
  leaseId: string,
  reason: ReturnType<ReturnType<typeof createAgentDatabaseLeaseStaleReasonReader>>,
) {
  if (reason !== "owner-prior-boot") {
    return;
  }
  const publish = () =>
    log.warn(`Released legacy agent database lease ${leaseId} from a prior boot.`);
  if (!deferSqlitePostCommitPublication(database, publish)) {
    publish();
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
    const staleReasonFor = createAgentDatabaseLeaseStaleReasonReader();
    for (const row of readAgentDatabaseLeases(database.db)) {
      const staleReason = staleReasonFor(row);
      if (staleReason) {
        clearAgentDatabaseLeaseVerifications(database.db, row.path);
        executeSqliteQuerySync(
          database.db,
          db.deleteFrom("agent_database_leases").where("lease_id", "=", row.lease_id),
        );
        reportPriorBootLeaseRelease(database.db, row.lease_id, staleReason);
        continue;
      }
      if (!agentId || row.agent_id === agentId) {
        throw new OpenClawAgentDatabaseLeaseActiveError(
          `Agent ${row.agent_id} database is still open in another process; stop the Gateway and other OpenClaw processes, or reboot, then rerun openclaw doctor --fix.`,
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
    const staleReasonFor = createAgentDatabaseLeaseStaleReasonReader();
    for (const row of readAgentDatabaseLeases(db)) {
      const staleReason = staleReasonFor(row);
      if (staleReason) {
        clearAgentDatabaseLeaseVerifications(db, row.path);
        executeSqliteQuerySync(
          db,
          query.deleteFrom("agent_database_leases").where("lease_id", "=", row.lease_id),
        );
        reportPriorBootLeaseRelease(db, row.lease_id, staleReason);
      } else {
        throw new OpenClawAgentDatabaseLeaseActiveError(
          `Agent ${row.agent_id} database is still open in another process; stop the Gateway and other OpenClaw processes, or reboot, then rerun openclaw doctor --fix.`,
        );
      }
    }
  });
}
