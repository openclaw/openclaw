import { setTimeout as delay } from "node:timers/promises";
import { isGatewayExternallySupervised } from "../../infra/gateway-supervision.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
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
import { withSqliteReclamationAuthorization } from "./session-accessor.sqlite-reclamation-commit.js";
import { withSqliteReclamationWorker } from "./session-accessor.sqlite-reclamation-worker.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { withSqliteMutationWorkerLifetime } from "./session-accessor.sqlite-worker-request.js";
import { hasPendingCanonicalSessionValidation } from "./session-canonical-validation.js";

const MAX_BATCH_ROWS = 128;
const MAX_BATCH_BYTES = 1024 * 1024;
const CONTENTION_BACKOFF_MS = [0, 25, 100, 250] as const;
// Active sessions with ongoing canonical-field writes (entry_json, current_session_id, …)
// legitimately never certify within a single drain pass: each two-phase read→certify
// snapshot mismatches and yields certifiedRows=0 while hasMore stays true. Bound the
// stall so the drain terminates this round, marks canonicalReady, and leaves the
// remaining pending rows for the next request's incremental pass instead of looping
// forever on a 250ms backoff (the historical 100%+ CPU storm root cause).
const MAX_STALL_BATCHES = 4;
const log = createSubsystemLogger("sessions/canonical-validation");

/** Certify dirty persisted rows before startup maintenance reads their full entries. */
export async function certifySessionCanonicalValidationPending(
  options: OpenClawAgentDatabaseOptions,
  withWorker = withSqliteReclamationWorker,
  assertCurrentOwner?: () => void,
): Promise<void> {
  assertCurrentOwner?.();
  const sourceEnv = options.env ?? process.env;
  const pathname = resolveOpenClawAgentSqlitePath(options);
  if (isIncognitoOpenClawAgentSqlitePath(pathname, options)) {
    return;
  }
  const retained = retainOpenClawAgentDatabaseReadOnly(options);
  if (!retained.found) {
    return;
  }
  const { database, claim } = retained;
  let oversizedRows = 0;
  try {
    let initializeCanonicalValidation = !hasOpenClawAgentCanonicalValidation(database);
    if (!initializeCanonicalValidation && !hasPendingCanonicalSessionValidation(database)) {
      return;
    }
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
        try {
          let contendedBatches = 0;
          let validation = getOpenClawAgentDatabaseValidation(database);
          while (true) {
            assertCurrentOwner?.();
            assertReadinessCurrent();
            claim.assertCurrent();
            const result = await withSqliteMutationWorkerLifetime(
              databaseOptions,
              async ({ assertCurrent, commitGate }) =>
                await withWorker(
                  databaseOptions,
                  claim,
                  async (worker) => {
                    const assertCommitAllowed = () => {
                      assertCurrentOwner?.();
                      assertReadinessCurrent();
                      assertCurrent();
                      worker.assertCurrent(databaseOptions, claim);
                    };
                    assertCommitAllowed();
                    return await withSqliteReclamationAuthorization(
                      commitGate,
                      database.db,
                      assertCommitAllowed,
                      (authorize) =>
                        worker.runCanonicalValidation({
                          databaseOptions,
                          claim,
                          validationOwner: { database, isCurrent: claim.isCurrent },
                          commitGate,
                          maxRows: MAX_BATCH_ROWS,
                          maxBytes: MAX_BATCH_BYTES,
                          initializeCanonicalValidation,
                          onCommitRequest: authorize,
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
                            ),
                        }),
                    );
                  },
                  () => {
                    assertCurrentOwner?.();
                    assertReadinessCurrent();
                    assertCurrent();
                    claim.assertCurrent();
                  },
                ),
            );
            assertCurrentOwner?.();
            assertReadinessCurrent();
            claim.assertCurrent();
            const currentValidation = getOpenClawAgentDatabaseValidation(database);
            if (!currentValidation || (validation && validation !== currentValidation)) {
              throw new Error("SQLite session reclamation database owner is no longer current");
            }
            validation ??= currentValidation;
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
              contendedBatches += 1;
              // After bounded consecutive stall rounds, accept that the remaining pending
              // rows belong to active sessions whose writes cannot settle within this pass.
              // Mark canonicalReady so request paths stop re-entering a non-converging drain;
              // already-certified rows are persisted and the leftover pending set is carried
              // forward for the next incremental drain. This preserves the consistency check
              // (pending semantics are unchanged) while ending the permanent 250ms backoff.
              if (contendedBatches >= MAX_STALL_BATCHES) {
                if (
                  !isOpenClawAgentDatabasePathCurrent(database) ||
                  !markOpenClawAgentCanonicalValidation(database)
                ) {
                  throw new Error("SQLite session reclamation database owner is no longer current");
                }
                return;
              }
              const waitMs = CONTENTION_BACKOFF_MS[contendedBatches - 1] ?? 250;
              await delay(waitMs);
            } else {
              contendedBatches = 0;
            }
            // The next batch rejoins both existing FIFOs behind already queued work.
          }
        } finally {
          claim.release();
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
