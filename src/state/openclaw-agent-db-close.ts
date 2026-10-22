import { statSync } from "node:fs";
import { disposeNodeSqliteDependents } from "../infra/kysely-sync-cache-state.js";
import { isPostgresSqlConnection, sqlPublicationAnchor } from "../infra/sql-connection.js";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import {
  prepareSqliteDatabaseCleanClose,
  revokeSqliteDatabaseAdmissionsForPath,
} from "../infra/sqlite-database-admission.js";
import { releaseAgentCreationClaimHandle } from "./agent-creation-claim.js";
import { releaseAgentDeletionDatabaseCleanup } from "./agent-deletion-cleanup.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db-contract.js";
import {
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "./openclaw-agent-db-identity.js";
import { releaseOpenClawAgentDatabaseLease } from "./openclaw-agent-db-lease.js";
import { invalidateOpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-cache.js";

/** Native handle close uses the lifecycle owner's existing leases and validation. */
export function createAgentDatabaseHandleCloser(cache: {
  leases: Map<string, { leaseId: string; env: NodeJS.ProcessEnv }>;
  failures: ReadonlyMap<string, unknown>;
  idleTimers: WeakMap<OpenClawAgentDatabase["db"], Disposable>;
}) {
  return function closeCachedOpenClawAgentDatabase(database: OpenClawAgentDatabase): void {
    // Retiring handles checkpoint once without waiting for peer readers.
    const lease = cache.leases.get(database.path);
    const alreadyClosed = !database.db.isOpen;
    const priorCheckpointError = database.walMaintenance.health?.state === "error";
    const postgres = isPostgresSqlConnection(database.db);
    const anchor = sqlPublicationAnchor(database.db);
    using seal = !alreadyClosed && !postgres ? prepareSqliteDatabaseCleanClose(anchor) : undefined;
    let clean: { path: string; publishSeal: () => boolean } | undefined;
    let retainRuntimeProof: boolean;
    try {
      if (!alreadyClosed && !postgres) {
        setSqliteBusyTimeout(anchor, 0);
      }
      disposeNodeSqliteDependents(anchor);
      database.walMaintenance.close({ checkpointMode: "TRUNCATE" });
      const healthy =
        !cache.failures.has(database.path) &&
        !priorCheckpointError &&
        database.walMaintenance.health?.state !== "error";
      const pathCurrent = !alreadyClosed && healthy && isOpenClawAgentDatabasePathCurrent(database);
      // Healthy peer handles keep runtime proof; restart proof still needs an empty WAL.
      retainRuntimeProof = healthy && (alreadyClosed || pathCurrent);
      if (database.db.isOpen) {
        database.db.close();
      }
      if (postgres && anchor.isOpen) {
        anchor.close();
      }
      if (pathCurrent && !postgres) {
        const { canonicalPath } = readOpenClawAgentDatabaseIdentity(database);
        // Native last-close may finish a checkpoint; a pinned WAL must remain unsealed.
        const closedWithEmptyWal =
          (statSync(`${canonicalPath}-wal`, { throwIfNoEntry: false })?.size ?? 0) === 0;
        if (seal && closedWithEmptyWal) {
          clean = { path: database.path, publishSeal: seal.publish };
        }
      }
    } catch (error) {
      if (lease) {
        invalidateOpenClawAgentDatabaseValidation(database.path);
        revokeSqliteDatabaseAdmissionsForPath(database.path);
      }
      throw error;
    }
    if (lease) {
      releaseOpenClawAgentDatabaseLease(
        lease.leaseId,
        { env: lease.env, initializationAgentPaths: [database.path] },
        clean ??
          (retainRuntimeProof ? (postgres ? "postgres-closed" : "uncheckpointed") : undefined),
      );
      cache.leases.delete(database.path);
    }
    releaseAgentDeletionDatabaseCleanup(database);
    releaseAgentCreationClaimHandle(database);
    cache.idleTimers.get(database.db)?.[Symbol.dispose]();
    cache.idleTimers.delete(database.db);
  };
}
