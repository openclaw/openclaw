import { on, once } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import type { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync-cache-state.js";
import { sqliteReaderDatabasePathKey } from "../../infra/sqlite-reader-lifecycle.js";
import { onSqliteWalCheckpoint } from "../../infra/sqlite-wal-checkpoint.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { cancelWorkerIdleGc, scheduleWorkerIdleGc } from "../../infra/worker-idle-gc.js";
import { recordOpenClawAgentCanonicalValidation } from "../../state/openclaw-agent-canonical-validation-receipt.js";
import {
  createOpenClawAgentDatabaseClaim,
  readOpenClawAgentDatabaseIdentity,
  type OpenClawAgentDatabaseClaim,
} from "../../state/openclaw-agent-db-identity.js";
import {
  assertOpenClawAgentDatabaseLease,
  type OpenClawAgentDatabaseWorkerLeaseReceipt,
} from "../../state/openclaw-agent-db-lease.js";
import { readOpenClawAgentDatabaseWorkerLeaseReceipt } from "../../state/openclaw-agent-db-lifecycle.js";
import { withFreshOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly-open.js";
import {
  getOpenClawAgentDatabaseValidation,
  markOpenClawAgentCanonicalValidation,
  type OpenClawAgentDatabaseValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import {
  borrowOpenClawAgentDatabase,
  settleOpenClawAgentDatabaseWorkerClose,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPath } from "../../state/openclaw-state-db-cache.js";
import type { CanonicalSessionValidationResult } from "./session-accessor.sqlite-contract.js";
import type { SqliteSessionReclamationPlan } from "./session-accessor.sqlite-lifecycle-types.js";
import {
  markSqliteReclamationSettled,
  SqliteReclamationRequestRefusedError,
  waitForSqliteReclamationCommit,
} from "./session-accessor.sqlite-reclamation-commit.js";
import type {
  SqliteCanonicalValidationWorkerRequest,
  SqliteReclamationWorkerRequest,
  SqliteReclamationPrepareRequest,
  SqliteReclamationPreparation,
  SqliteReclamationWorkerCloseRequest,
  SqliteReclamationWorkerMessage,
} from "./session-accessor.sqlite-reclamation-worker.types.js";
import { withWorkerWriteAdmission } from "./session-accessor.sqlite-worker-admission.runtime.js";
import {
  runWithSqliteMutationWorkerCoordination,
  type SqliteMutationWorkerCoordination,
} from "./session-accessor.sqlite-worker-coordination.js";
import type { SqliteMutationWorkerMessage } from "./session-accessor.sqlite-worker-request.js";
import type { ValidatedCanonicalSessionValidationBatch } from "./session-canonical-validation.js";
import {
  prepareSessionColdSourceGuard,
  SessionColdSourceRefusedError,
} from "./session-cold-storage-source-guard.worker.js";
import type { SessionColdWorkerData } from "./session-cold-storage-worker.js";
import type { SessionColdMutationResult } from "./session-cold-storage.types.js";

function settleReclamationDatabase(pathname: string): {
  cleanupWarnings: string[];
  settled: boolean;
} {
  const outcome = settleOpenClawAgentDatabaseWorkerClose(pathname);
  return {
    cleanupWarnings: outcome.errors.map((error) => error.message),
    settled: outcome.settled,
  };
}

function throwReclamationFailure(
  error: unknown,
  cleanup: Awaited<ReturnType<typeof settleReclamationDatabase>>,
  commitGate: SharedArrayBuffer | undefined,
): never {
  if (!cleanup.settled) {
    throw new AggregateError(
      [error, ...cleanup.cleanupWarnings.map((warning) => new Error(warning))],
      "SQLite session reclamation failed and Worker cleanup is incomplete; restart OpenClaw before deleting the owning agent",
      { cause: error },
    );
  }
  markSqliteReclamationSettled(commitGate);
  throw error;
}

export async function runColdMutationWorkerPort(
  port: MessagePort,
  data: SessionColdWorkerData,
): Promise<void> {
  // SAFETY: the typed parent installs its outcome owner before sending this private request.
  const [request] = (await once(port, "message")) as [
    { type: string; coordination: SqliteMutationWorkerCoordination },
  ];
  if (request.type !== "mutate") {
    throw new Error("SQLite cold mutation Worker received invalid admission");
  }
  const response = await runWithSqliteMutationWorkerCoordination(
    request.coordination,
    data.plan.databaseOptions,
    (databaseOptions) =>
      runColdMutationWorker(port, {
        ...data,
        plan: { ...data.plan, databaseOptions },
      }),
  );
  port.postMessage(response);
  port.close();
}

async function runColdMutationWorker(port: MessagePort, data: SessionColdWorkerData) {
  const { mutateSessionColdTranscriptInWorker, prepareSessionColdRestoreInWorker } =
    await import("./session-cold-storage-worker.js");
  // Restore materialization must finish before requesting any write admission.
  const coldRecords =
    data.plan.kind === "cold-restore"
      ? await prepareSessionColdRestoreInWorker(data.plan)
      : undefined;
  using sourceGuard = prepareSessionColdSourceGuard(
    data.plan.databaseOptions,
    data.plan.kind === "cold-restore" ? data.plan.guard?.sources : undefined,
    data.sourceMatches,
  );
  const commitGate = data.commitGate;
  let result: SessionColdMutationResult;
  let validation: OpenClawAgentDatabaseValidation | undefined;
  try {
    result = await withWorkerWriteAdmission(
      port,
      0,
      data.plan.databaseOptions,
      async (openedDatabase) => {
        let transactionDatabase: DatabaseSync | undefined;
        try {
          return mutateSessionColdTranscriptInWorker(
            data.plan,
            coldRecords,
            (database, sourceValidation) => {
              transactionDatabase = database.db;
              // Native admission can service the grant before its message arrives.
              for (const { index, matches } of data.sourceMatches ?? []) {
                const match = sourceValidation?.conversationMatches.find(
                  (value) => value.index === index,
                );
                if (!match) {
                  throw new Error("Cold restoration omitted its source alternatives");
                }
                for (const alternative of match.alternatives) {
                  Atomics.store(matches, alternative + 1, 1);
                }
                Atomics.store(matches, 0, 1);
              }
              waitForSqliteReclamationCommit(commitGate, () =>
                port.postMessage({ type: "commit-request", operationId: 0 }),
              );
            },
            sourceGuard,
          );
        } catch (error) {
          // The native transaction has rolled back before a post-grant refusal is returned.
          if (error instanceof SessionColdSourceRefusedError) {
            return {
              archivedTranscripts: 0,
              externalizedTranscripts: 0,
              restored: false,
              refusedSource: error.refusal,
            };
          }
          throw error;
        } finally {
          validation = getOpenClawAgentDatabaseValidation(openedDatabase);
          if (
            transactionDatabase &&
            (!transactionDatabase.isOpen || !transactionDatabase.isTransaction)
          ) {
            markSqliteReclamationSettled(commitGate);
          }
        }
      },
    );
  } catch (error) {
    const cleanup = settleReclamationDatabase(data.plan.databaseOptions.path);
    throwReclamationFailure(error, cleanup, commitGate);
  }
  const cleanup = settleReclamationDatabase(data.plan.databaseOptions.path);
  const workerResult = {
    result,
    ...(cleanup.cleanupWarnings.length > 0 ? { cleanupWarnings: cleanup.cleanupWarnings } : {}),
    ...(!cleanup.settled ? { cleanupIncomplete: true } : {}),
  };
  return {
    type: "reclaimed",
    operationId: 0,
    result: workerResult,
    settled: true,
    validation: cleanup.settled ? validation : undefined,
  } satisfies SqliteMutationWorkerMessage<typeof workerResult>;
}

export async function runReclamationWorkerPort(
  port: MessagePort,
  databaseOptions: SqliteSessionReclamationPlan["databaseOptions"],
  pooledTask?: { operationId: number },
): Promise<{ cleanupWarnings: string[]; settled: boolean }> {
  let reclaimSqliteSessionInTransaction: typeof import("./session-accessor.sqlite-reclamation.js").reclaimSqliteSessionInTransaction;
  let claim: OpenClawAgentDatabaseClaim | undefined;
  let retainedDatabase: DatabaseSync | undefined;
  let lease: OpenClawAgentDatabaseWorkerLeaseReceipt | undefined;
  let operationId = pooledTask?.operationId ?? 0;
  let failureCleanup: Awaited<ReturnType<typeof settleReclamationDatabase>> | undefined;
  let checkpointResultOwnedByRequest = false;
  const checkpointPath = sqliteReaderDatabasePathKey(databaseOptions.path);
  const stopCheckpointRelay = onSqliteWalCheckpoint(({ databasePath, ...snapshot }) => {
    if (!checkpointResultOwnedByRequest && databasePath === checkpointPath && claim?.isCurrent()) {
      port.postMessage({
        type: "checkpoint",
        operationId,
        snapshot,
      } satisfies SqliteReclamationWorkerMessage);
    }
  });
  const closeDatabase = () => {
    checkpointResultOwnedByRequest = false;
    const cleanup = settleReclamationDatabase(databaseOptions.path);
    claim?.release();
    claim = undefined;
    return cleanup;
  };
  try {
    for await (const [message] of on(port, "message")) {
      // SAFETY: only the typed private parent sends on this port.
      const request = message as
        | SqliteReclamationWorkerRequest
        | SqliteReclamationPrepareRequest
        | SqliteCanonicalValidationWorkerRequest
        | SqliteReclamationWorkerCloseRequest
        | { type: "admission" };
      // Admission replies also reach the iterator; the active request consumes them below.
      if (request.type === "admission") {
        continue;
      }
      cancelWorkerIdleGc();
      operationId = request.operationId;
      if (pooledTask) {
        pooledTask.operationId = operationId;
      }
      failureCleanup = undefined;
      const response = await runWithSqliteMutationWorkerCoordination(
        request.coordination,
        databaseOptions,
        async (options) => {
          if (request.type === "close") {
            const cleanup = closeDatabase();
            if (pooledTask) {
              if (!cleanup.settled) {
                throw new Error("Canonical validation task could not close its agent database");
              }
              // Keep native close under this task's coordinator and parent's writer admission.
              closeOpenClawStateDatabaseByPath(request.coordination.databasePath);
            }
            return {
              type: "closed",
              ...cleanup,
            } satisfies SqliteReclamationWorkerMessage;
          }
          try {
            claim?.assertCurrent();
            if (request.type === "reclaim") {
              // Canonical-only workers do not need the deletion graph; load it before admission.
              ({ reclaimSqliteSessionInTransaction } =
                await import("./session-accessor.sqlite-reclamation.js"));
            }
            // Parsing and validation stay outside foreground write admission. The batch
            // never crosses threads; certification compares the exact captured inputs.
            const canonical =
              request.type === "canonical-validation"
                ? await import("./session-canonical-validation.js")
                : undefined;
            let prepared: ValidatedCanonicalSessionValidationBatch | undefined;
            if (
              canonical &&
              request.type === "canonical-validation" &&
              !request.initializeCanonicalValidation
            ) {
              const prepare = (database: { agentId: string; db: DatabaseSync }) => {
                const batch = canonical.readPendingCanonicalSessionValidationBatch(
                  database,
                  request,
                );
                return canonical.validateCanonicalSessionValidationBatch(batch);
              };
              if (retainedDatabase) {
                prepared = prepare({ agentId: options.agentId, db: retainedDatabase });
              } else {
                const opened = withFreshOpenClawAgentDatabaseReadOnly(prepare, options);
                if (!opened.found) {
                  throw new Error(`Cannot validate canonical sessions: ${opened.reason}`);
                }
                prepared = opened.value;
              }
            }
            const assertExpectedSource =
              request.type === "prepare"
                ? () =>
                    assertExistingDatabaseIdentity(
                      options.path,
                      request.expectedSource.key,
                      request.expectedSource.birthtime,
                    )
                : undefined;
            let validation: OpenClawAgentDatabaseValidation | undefined;
            const result = await withWorkerWriteAdmission(
              port,
              operationId,
              options,
              (database) => {
                const nativeIdentity = readOpenClawAgentDatabaseIdentity(database);
                const openedForRequest = !claim;
                if (!claim) {
                  const borrowed = borrowOpenClawAgentDatabase(options);
                  claim = createOpenClawAgentDatabaseClaim(database, borrowed.release);
                  retainedDatabase = database.db;
                  lease = readOpenClawAgentDatabaseWorkerLeaseReceipt(options.path);
                  port.postMessage({
                    type: "lease",
                    receipt: lease,
                  } satisfies SqliteReclamationWorkerMessage);
                }
                claim.assertCurrent();
                const currentClaim = claim;
                if (retainedDatabase !== database.db || !lease) {
                  throw new Error("SQLite session reclamation database owner is no longer current");
                }
                assertOpenClawAgentDatabaseLease(lease.leaseId, options);
                if (
                  request.type === "prepare" &&
                  (typeof nativeIdentity.identity !== "string" ||
                    `file:${nativeIdentity.identity}` !== request.expectedSource.key ||
                    (request.expectedSource.birthtime !== undefined &&
                      nativeIdentity.birthtime !== request.expectedSource.birthtime))
                ) {
                  throw new Error(
                    "SQLite reclamation native source differs from its opening expectation",
                  );
                }
                try {
                  if (request.type === "prepare") {
                    if (typeof nativeIdentity.identity !== "string") {
                      throw new Error("SQLite reclamation requires an admitted file source");
                    }
                    return {
                      source: { ...nativeIdentity, identity: nativeIdentity.identity },
                      validation: getOpenClawAgentDatabaseValidation(database),
                    } satisfies SqliteReclamationPreparation;
                  }
                  // Deferred periodic work outside this synchronous page unit still needs its relay.
                  checkpointResultOwnedByRequest =
                    request.type === "reclaim" && request.plan.kind === "maintenance-pages";
                  const authorizeCommit = () => {
                    // The parent admitted this operation through its FIFO. Recheck
                    // actual session ownership here, without a second host round trip.
                    if (request.type === "reclaim") {
                    }
                  };
                  const reclaimed =
                    request.type === "canonical-validation"
                      ? runOpenClawAgentWriteTransaction(
                          (transactionDatabase) => {
                            currentClaim.assertCurrent();
                            if (!canonical) {
                              throw new Error("Canonical validation lost its prepared batch");
                            }
                            const counts = { validatedRows: 0, certifiedRows: 0, oversizedRows: 0 };
                            if (request.initializeCanonicalValidation) {
                              // The parent may have revoked proof this fresh worker still sees on disk.
                              canonical.seedCanonicalSessionValidation(transactionDatabase);
                            } else {
                              if (!prepared) {
                                throw new Error("Canonical validation lost its prepared batch");
                              }
                              counts.certifiedRows =
                                canonical.compareAndCertifyCanonicalSessionValidationBatch(
                                  transactionDatabase,
                                  prepared,
                                );
                              counts.validatedRows = prepared.rows.length;
                              counts.oversizedRows = prepared.oversizedRows;
                            }
                            const hasMore =
                              canonical.hasPendingCanonicalSessionValidation(transactionDatabase);
                            authorizeCommit();
                            if (!hasMore) {
                              recordOpenClawAgentCanonicalValidation(transactionDatabase);
                              if (!markOpenClawAgentCanonicalValidation(transactionDatabase)) {
                                throw new Error("Canonical validation lost its admitted owner");
                              }
                            }
                            return {
                              validatedRows: counts.validatedRows,
                              certifiedRows: counts.certifiedRows,
                              hasMore,
                              oversizedRows: counts.oversizedRows,
                            } satisfies CanonicalSessionValidationResult;
                          },
                          options,
                          { operationLabel: "session.canonical-validation.certify" },
                        )
                      : reclaimSqliteSessionInTransaction(
                          { ...request.plan, databaseOptions: options },
                          {
                            beforeMutation: currentClaim.assertCurrent,
                            onCommit: authorizeCommit,
                          },
                        );
                  // Warm results must not revive proof invalidated by the parent between requests.
                  if (openedForRequest) {
                    validation = getOpenClawAgentDatabaseValidation(database);
                  }
                  return reclaimed;
                } finally {
                  checkpointResultOwnedByRequest = false;
                  clearNodeSqliteKyselyCacheForDatabase(database.db);
                }
              },
              assertExpectedSource,
            );
            return {
              type: "reclaimed",
              operationId,
              result,
              settled: true,
              validation,
            } satisfies SqliteMutationWorkerMessage<typeof result>;
          } catch (error) {
            // Canonical validation retains its scoped native-failure/drain contract.
            if (
              (request.type === "reclaim" || request.type === "prepare") &&
              !pooledTask &&
              error instanceof SqliteReclamationRequestRefusedError &&
              ((!claim && !retainedDatabase) ||
                (claim?.isCurrent() && retainedDatabase?.isOpen && !retainedDatabase.isTransaction))
            ) {
              return {
                type: "refused",
                operationId,
                settled: true,
              } satisfies SqliteReclamationWorkerMessage;
            }
            failureCleanup = closeDatabase();
            return throwReclamationFailure(error, failureCleanup, undefined);
          }
        },
      );
      if (response.type === "closed") {
        port.postMessage(response);
        if (pooledTask) {
          const [release]: unknown[] = await once(port, "message");
          if (
            !isRecord(release) ||
            release.type !== "release" ||
            release.operationId !== operationId
          ) {
            throw new Error("Canonical validation task received an invalid close release");
          }
        }
        port.close();
        return response;
      }
      // The matching settlement releases this victim's admission and all plan buffers.
      if (request.type === "reclaim") {
        request.plan.materializedPlans.length = 0;
      }
      port.postMessage(response);
      scheduleWorkerIdleGc();
    }
    throw new Error("SQLite session reclamation parent closed without retiring its worker");
  } catch (error) {
    if (failureCleanup) {
      port.postMessage({
        type: "closed",
        ...failureCleanup,
      } satisfies SqliteReclamationWorkerMessage);
    }
    throw error;
  } finally {
    stopCheckpointRelay();
    claim?.release();
  }
}
