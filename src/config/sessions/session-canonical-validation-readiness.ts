import { setTimeout as delay } from "node:timers/promises";
import { withEngineStoreAdmission } from "../../infra/database-engine/admission-scope.js";
import { isGatewayExternallySupervised } from "../../infra/gateway-supervision.js";
import { runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { loadOpenClawAgentCanonicalValidationReceipt } from "../../state/openclaw-agent-canonical-validation-receipt.js";
import {
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  getOpenClawAgentDatabaseValidation,
  hasOpenClawAgentCanonicalValidation,
  markOpenClawAgentCanonicalValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import {
  resolveOpenClawStateDirForDatabasePath,
  resolveOpenClawStateSqlitePath,
} from "../../state/openclaw-state-db.paths.js";
import {
  withSqliteReclamationWorker,
  type ClaimedReclamationWorkerUse,
} from "./session-accessor.sqlite-reclamation-worker.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { withSqliteMutationWorkerLifetime } from "./session-accessor.sqlite-worker-request.js";

const MAX_BATCH_ROWS = 128;
const MAX_BATCH_BYTES = 1024 * 1024;
const CONTENTION_BACKOFF_MS = [0, 25, 100, 250] as const;
const log = createSubsystemLogger("sessions/canonical-validation");
// Share only active runtime drains; native close/reopen creates a different owner.
const runtimeDrains = new Map<string, Promise<void>>();

/** Startup and Doctor certify pending rows through their retained database owner. */
export async function certifySessionCanonicalValidationPending(
  options: OpenClawAgentDatabaseOptions,
  withWorker: ClaimedReclamationWorkerUse = withSqliteReclamationWorker,
  assertCurrentOwner?: () => void,
): Promise<void> {
  const assertOwnerCurrent = () => assertCurrentOwner?.();
  assertOwnerCurrent();
  const sourceEnv = options.env ?? process.env;
  const pathname = resolveOpenClawAgentSqlitePath(options);
  if (isIncognitoOpenClawAgentSqlitePath(pathname, options)) {
    return;
  }
  const native = withEngineStoreAdmission(() => retainOpenClawAgentDatabaseReadOnly(options));
  if (!native.found) {
    return;
  }
  const { database, claim } = native;
  const validationOwner = { database, isCurrent: claim.isCurrent };
  const drainKey = readOpenClawAgentDatabaseIdentity(database).incarnation;
  let oversizedRows = 0;
  try {
    const initialize = withEngineStoreAdmission(() =>
      runSqliteReadOperationSync(database.db, () => {
        loadOpenClawAgentCanonicalValidationReceipt(database);
        // Import, repair, and main-key writers revoke readiness when they queue validation.
        return !hasOpenClawAgentCanonicalValidation(database);
      }),
    );
    if (!initialize) {
      return;
    }
    let initializeCanonicalValidation = true;
    const databaseOptions = {
      agentId: normalizeAgentId(options.agentId),
      path: readOpenClawAgentDatabaseIdentity(database).filename,
      env: {
        OPENCLAW_STATE_DIR: resolveOpenClawStateDirForDatabasePath(
          options.database?.path ?? resolveOpenClawStateSqlitePath(sourceEnv),
        ),
        ...(isGatewayExternallySupervised(sourceEnv)
          ? { OPENCLAW_SUPERVISOR_MODE: "external" }
          : {}),
      },
    };
    return await withSqliteMutationWorkerLifetime(
      databaseOptions,
      async ({ assertCurrent: assertReadinessCurrent }) => {
        const shareRuntimeDrain =
          withWorker === withSqliteReclamationWorker && assertCurrentOwner === undefined;
        const drain = async () => {
          let contendedBatches = 0;
          while (true) {
            assertOwnerCurrent();
            assertReadinessCurrent();
            claim.assertCurrent();
            const result = await withSqliteMutationWorkerLifetime(
              databaseOptions,
              async ({ assertCurrent, signal }) =>
                await withWorker(
                  databaseOptions,
                  claim,
                  async (worker) => {
                    const assertCommitAllowed = () => {
                      assertOwnerCurrent();
                      assertReadinessCurrent();
                      assertCurrent();
                      worker.assertCurrent(databaseOptions, claim);
                    };
                    assertCommitAllowed();
                    return await worker.runCanonicalValidation({
                      databaseOptions,
                      claim,
                      validationOwner,
                      maxRows: MAX_BATCH_ROWS,
                      maxBytes: MAX_BATCH_BYTES,
                      initializeCanonicalValidation,
                      withWriteAdmission: async (run, reclamationAdmission) =>
                        await runExclusiveSqliteSessionWrite(
                          databaseOptions,
                          async () => {
                            let refusal: { error: unknown } | undefined;
                            try {
                              assertCommitAllowed();
                            } catch (error) {
                              refusal = { error };
                            }
                            await run(refusal);
                          },
                          "session.canonical-validation.certify",
                          { reclamationAdmission },
                          "worker",
                          signal,
                        ),
                    });
                  },
                  () => {
                    assertOwnerCurrent();
                    assertReadinessCurrent();
                    assertCurrent();
                    claim.assertCurrent();
                  },
                  signal,
                ),
            );
            assertOwnerCurrent();
            assertReadinessCurrent();
            claim.assertCurrent();
            const currentValidation = getOpenClawAgentDatabaseValidation(database);
            if (!currentValidation) {
              throw new Error("SQLite session reclamation database owner is no longer current");
            }
            oversizedRows += result.oversizedRows;
            if (!result.hasMore) {
              if (
                !isOpenClawAgentDatabasePathCurrent(database) ||
                !markOpenClawAgentCanonicalValidation(database)
              ) {
                throw new Error("SQLite session reclamation database owner is no longer current");
              }
              return;
            }
            if (initializeCanonicalValidation) {
              initializeCanonicalValidation = false;
              continue;
            }
            if (result.certifiedRows === 0) {
              const waitMs = CONTENTION_BACKOFF_MS[contendedBatches] ?? 250;
              contendedBatches = Math.min(contendedBatches + 1, CONTENTION_BACKOFF_MS.length - 1);
              await delay(waitMs);
            } else {
              contendedBatches = 0;
            }
            // The next batch rejoins both existing FIFOs behind already queued work.
          }
        };
        let completion: Promise<void> | undefined;
        let ownsDrain = false;
        try {
          assertOwnerCurrent();
          assertReadinessCurrent();
          claim.assertCurrent();
          completion = shareRuntimeDrain ? runtimeDrains.get(drainKey) : undefined;
          ownsDrain = completion === undefined;
          if (!completion) {
            completion = drain();
            if (shareRuntimeDrain) {
              runtimeDrains.set(drainKey, completion);
            }
          }
          await completion;
          assertOwnerCurrent();
          assertReadinessCurrent();
          claim.assertCurrent();
          if (
            !isOpenClawAgentDatabasePathCurrent(database) ||
            !hasOpenClawAgentCanonicalValidation(database)
          ) {
            throw new Error("SQLite session reclamation database owner is no longer current");
          }
        } finally {
          if (ownsDrain && runtimeDrains.get(drainKey) === completion) {
            runtimeDrains.delete(drainKey);
          }
        }
      },
    );
  } finally {
    claim.release();
    if (oversizedRows > 0) {
      log.warn("Canonical session validation processed oversized rows in its Worker", {
        path: pathname,
        rows: oversizedRows,
        batchByteLimit: MAX_BATCH_BYTES,
      });
    }
  }
}
