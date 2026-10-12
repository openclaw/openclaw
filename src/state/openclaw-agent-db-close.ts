import { statSync } from "node:fs";
import { disposeNodeSqliteDependents } from "../infra/kysely-sync-cache-state.js";
import { isSqliteWalWorkerMaintained } from "../infra/sqlite-wal-write-admission.js";
import { releaseAgentCreationClaimHandle } from "./agent-creation-claim.js";
import { releaseAgentDeletionDatabaseCleanup } from "./agent-deletion-cleanup.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db-contract.js";
import {
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "./openclaw-agent-db-identity.js";
import { releaseOpenClawAgentDatabaseLease } from "./openclaw-agent-db-lease.js";
import { clearOpenClawAgentIntegrityVerification } from "./openclaw-quarantine-store.js";

/** Native handle close uses the lifecycle owner's existing leases and validation. */
export function createAgentDatabaseHandleCloser(cache: {
  leases: Map<string, { leaseId: string; env: NodeJS.ProcessEnv }>;
  failures: ReadonlyMap<string, unknown>;
  idleTimers: WeakMap<OpenClawAgentDatabase["db"], Disposable>;
}) {
  return function closeCachedOpenClawAgentDatabase(
    database: OpenClawAgentDatabase,
    options: { eviction?: boolean } = {},
  ): void {
    // Eviction must stay cheap: PASSIVE skips waiting on concurrent readers,
    // whose drained TRUNCATE checkpoints blocked the event loop for seconds.
    const lease = cache.leases.get(database.path);
    const alreadyClosed = !database.db.isOpen;
    const delegated = isSqliteWalWorkerMaintained(database.db);
    const priorCheckpointError = database.walMaintenance.health?.state === "error";
    let clean: { path: string; identity: string } | undefined;
    let retainRuntimeProof: boolean;
    try {
      disposeNodeSqliteDependents(database.db);
      const checkpointed = database.walMaintenance.close(
        options.eviction ? { checkpointMode: "PASSIVE" } : undefined,
      );
      const healthy = !cache.failures.has(database.path);
      const pathCurrent = !alreadyClosed && healthy && isOpenClawAgentDatabasePathCurrent(database);
      // Delegated and reader-pinned closes retain runtime proof; restart proof needs a checkpoint.
      retainRuntimeProof =
        healthy &&
        !priorCheckpointError &&
        (alreadyClosed ||
          (pathCurrent && (delegated || database.walMaintenance.health?.state === "blocked")));
      if (database.db.isOpen) {
        database.db.close();
      }
      if (pathCurrent) {
        const { identity, canonicalPath } = readOpenClawAgentDatabaseIdentity(database);
        // Native last-close may finish a checkpoint; a pinned WAL must remain unsealed.
        const closedWithEmptyWal =
          delegated &&
          !priorCheckpointError &&
          (statSync(`${canonicalPath}-wal`, { throwIfNoEntry: false })?.size ?? 0) === 0;
        if (typeof identity === "string" && (checkpointed || closedWithEmptyWal)) {
          clean = { path: database.path, identity };
        }
      }
    } catch (error) {
      if (lease) {
        clearOpenClawAgentIntegrityVerification(database.path, lease.env);
      }
      throw error;
    }
    if (lease) {
      releaseOpenClawAgentDatabaseLease(
        lease.leaseId,
        { env: lease.env, initializationAgentPaths: [database.path] },
        clean ?? (retainRuntimeProof ? "uncheckpointed" : undefined),
      );
      cache.leases.delete(database.path);
    }
    releaseAgentDeletionDatabaseCleanup(database);
    releaseAgentCreationClaimHandle(database);
    cache.idleTimers.get(database.db)?.[Symbol.dispose]();
    cache.idleTimers.delete(database.db);
  };
}
