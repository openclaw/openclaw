import { statSync } from "node:fs";
import { disposeNodeSqliteDependents } from "../infra/kysely-sync-cache-state.js";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
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
  return function closeCachedOpenClawAgentDatabase(database: OpenClawAgentDatabase): void {
    // Retiring handles checkpoint once without waiting for peer readers.
    const lease = cache.leases.get(database.path);
    const alreadyClosed = !database.db.isOpen;
    const priorCheckpointError = database.walMaintenance.health?.state === "error";
    let clean: { path: string; identity: string } | undefined;
    let retainRuntimeProof: boolean;
    try {
      if (!alreadyClosed) {
        setSqliteBusyTimeout(database.db, 0);
      }
      disposeNodeSqliteDependents(database.db);
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
      if (pathCurrent) {
        const { identity, canonicalPath } = readOpenClawAgentDatabaseIdentity(database);
        // Native last-close may finish a checkpoint; a pinned WAL must remain unsealed.
        const closedWithEmptyWal =
          (statSync(`${canonicalPath}-wal`, { throwIfNoEntry: false })?.size ?? 0) === 0;
        if (typeof identity === "string" && closedWithEmptyWal) {
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
