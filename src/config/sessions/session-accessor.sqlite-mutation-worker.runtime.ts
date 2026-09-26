import { on, once } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync-cache-state.js";
import { sqliteReaderDatabasePathKey } from "../../infra/sqlite-reader-lifecycle.js";
import { onSqliteWalCheckpoint } from "../../infra/sqlite-wal-checkpoint.js";
import { cancelWorkerIdleGc, scheduleWorkerIdleGc } from "../../infra/worker-idle-gc.js";
import { recordOpenClawAgentCanonicalValidation } from "../../state/openclaw-agent-canonical-validation-receipt.js";
import {
  createOpenClawAgentDatabaseClaim,
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
  type OpenClawAgentDatabaseValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import {
  borrowOpenClawAgentDatabase,
  settleOpenClawAgentDatabaseWorkerClose,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabaseWorkerCloseResult,
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
  SqliteReclamationWorkerCloseRequest,
  SqliteReclamationWorkerMessage,
} from "./session-accessor.sqlite-reclamation-worker.js";
import { withWorkerWriteAdmission } from "./session-accessor.sqlite-worker-admission.runtime.js";
import {
  runWithSqliteMutationWorkerCoordination,
  type SqliteMutationWorkerCoordination,
} from "./session-accessor.sqlite-worker-coordination.js";
import type { SqliteMutationWorkerMessage } from "./session-accessor.sqlite-worker-request.js";
import type { ValidatedCanonicalSessionValidationBatch } from "./session-canonical-validation.js";
import type {
  SessionColdWorkerData,
  SessionColdMutationResult,
} from "./session-cold-storage-worker.js";

const WORKER_CLOSE_MAX_ATTEMPTS = 3;

async function settleReclamationDatabase(
  pathname: string,
): Promise<{ cleanupWarnings: string[]; settled: boolean }> {
  const warnings = new Set<string>();
  let outcome: OpenClawAgentDatabaseWorkerCloseResult = { errors: [], settled: false };
  for (let attempt = 0; attempt < WORKER_CLOSE_MAX_ATTEMPTS; attempt += 1) {
    outcome = settleOpenClawAgentDatabaseWorkerClose(pathname);
    outcome.errors.forEach((error) => warnings.add(error.message));
    if (outcome.settled) {
      break;
    }
    if (attempt + 1 < WORKER_CLOSE_MAX_ATTEMPTS) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25 * 2 ** attempt);
      });
    }
  }
  return { cleanupWarnings: [...warnings], settled: outcome.settled };
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
    0,
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
          const changed = mutateSessionColdTranscriptInWorker(
            data.plan,
            coldRecords,
            (database) => {
              transactionDatabase = database.db;
              waitForSqliteReclamationCommit(commitGate, () =>
                port.postMessage({ type: "commit-request", operationId: 0 }),
              );
            },
          );
          return changed;
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
    const cleanup = await settleReclamationDatabase(data.plan.databaseOptions.path);
    if (cleanup.settled) {
      markSqliteReclamationSettled(commitGate);
    } else {
      throw new AggregateError(
        [error, ...cleanup.cleanupWarnings.map((warning) => new Error(warning))],
        "SQLite session reclamation failed and Worker cleanup is incomplete; restart OpenClaw before deleting the owning agent",
        { cause: error },
      );
    }
    throw error;
  }
  const cleanup = await settleReclamationDatabase(data.plan.databaseOptions.path);
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
  let commitGate: SharedArrayBuffer | undefined;
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
  const closeDatabase = async () => {
    checkpointResultOwnedByRequest = false;
    const cleanup = await settleReclamationDatabase(databaseOptions.path);
    claim?.release();
    claim = undefined;
    return cleanup;
  };
  try {
    for await (const [message] of on(port, "message")) {
      // SAFETY: only the typed private parent sends on this port.
      const request = message as
        | SqliteReclamationWorkerRequest
        | SqliteCanonicalValidationWorkerRequest
        | SqliteReclamationWorkerCloseRequest
        | { type: "admission" };
      // Admission replies also reach the iterator; the active request consumes them below.
      if (request.type === "admission") {
        continue;
      }
      cancelWorkerIdleGc();
      const requestDatabaseOptions =
        request.type === "close"
          ? databaseOptions
          : request.type === "canonical-validation"
            ? request.databaseOptions
            : request.plan.databaseOptions;
      if (
        request.operationId !== ++operationId ||
        !isDeepStrictEqual(requestDatabaseOptions, databaseOptions)
      ) {
        throw new Error("SQLite session reclamation database owner is no longer current");
      }
      if (pooledTask) {
        pooledTask.operationId = operationId;
      }
      failureCleanup = undefined;
      const response = await runWithSqliteMutationWorkerCoordination(
        request.coordination,
        operationId,
        databaseOptions,
        async (options) => {
          if (request.type === "close") {
            const cleanup = await closeDatabase();
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
          commitGate = request.commitGate;
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
            const maintenanceOwner =
              request.type === "reclaim" && request.plan.kind === "maintenance-plan"
                ? await import("./session-accessor.sqlite-maintenance-transaction.js")
                : undefined;
            const maintenance =
              request.type === "reclaim" && request.plan.kind === "maintenance-plan"
                ? maintenanceOwner?.prepareSessionMaintenanceInWorker({
                    ...request.plan,
                    databaseOptions: options,
                  })
                : undefined;
            let validation: OpenClawAgentDatabaseValidation | undefined;
            const result = await withWorkerWriteAdmission(
              port,
              operationId,
              options,
              (database) => {
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
                try {
                  // Deferred periodic work outside this synchronous page unit still needs its relay.
                  checkpointResultOwnedByRequest =
                    request.type === "reclaim" && request.plan.kind === "maintenance-pages";
                  const authorizeCommit = () =>
                    waitForSqliteReclamationCommit(request.commitGate, () =>
                      port.postMessage({
                        type: "commit-request",
                        operationId,
                      } satisfies SqliteReclamationWorkerMessage),
                    );
                  const reclaimed =
                    request.type === "canonical-validation"
                      ? runOpenClawAgentWriteTransaction(
                          (transactionDatabase) => {
                            currentClaim.assertCurrent();
                            if (!canonical) {
                              throw new Error("Canonical validation lost its prepared batch");
                            }
                            if (request.initializeCanonicalValidation) {
                              // The parent may have revoked proof this fresh worker still sees on disk.
                              canonical.seedCanonicalSessionValidation(transactionDatabase);
                              const hasMore =
                                canonical.hasPendingCanonicalSessionValidation(transactionDatabase);
                              authorizeCommit();
                              if (!hasMore) {
                                recordOpenClawAgentCanonicalValidation(transactionDatabase);
                              }
                              return {
                                validatedRows: 0,
                                certifiedRows: 0,
                                hasMore,
                                oversizedRows: 0,
                              } satisfies CanonicalSessionValidationResult;
                            }
                            if (!prepared) {
                              throw new Error("Canonical validation lost its prepared batch");
                            }
                            const batch = prepared;
                            const certifiedRows =
                              canonical.compareAndCertifyCanonicalSessionValidationBatch(
                                transactionDatabase,
                                batch,
                              );
                            const hasMore =
                              canonical.hasPendingCanonicalSessionValidation(transactionDatabase);
                            authorizeCommit();
                            if (!hasMore) {
                              recordOpenClawAgentCanonicalValidation(transactionDatabase);
                            }
                            return {
                              validatedRows: batch.rows.length,
                              certifiedRows,
                              hasMore,
                              oversizedRows: batch.oversizedRows,
                            } satisfies CanonicalSessionValidationResult;
                          },
                          options,
                          { operationLabel: "session.canonical-validation.certify" },
                        )
                      : request.plan.kind === "maintenance-plan" && maintenanceOwner
                        ? maintenanceOwner.reclaimSessionMaintenanceInTransaction(
                            { ...request.plan, databaseOptions: options },
                            {
                              beforeMutation: currentClaim.assertCurrent,
                              onCommit: authorizeCommit,
                            },
                            maintenance,
                          )
                        : reclaimSqliteSessionInTransaction(
                            { ...request.plan, databaseOptions: options },
                            {
                              beforeMutation: currentClaim.assertCurrent,
                              onCommit: authorizeCommit,
                              afterCommit: () => markSqliteReclamationSettled(request.commitGate),
                            },
                          );
                  // Warm results must not revive proof invalidated by the parent between requests.
                  if (openedForRequest) {
                    validation = getOpenClawAgentDatabaseValidation(database);
                  }
                  return reclaimed;
                } finally {
                  checkpointResultOwnedByRequest = false;
                  if (!database.db.isOpen || !database.db.isTransaction) {
                    markSqliteReclamationSettled(commitGate);
                  }
                  clearNodeSqliteKyselyCacheForDatabase(database.db);
                }
              },
            ).finally(() => maintenance?.release());
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
              request.type === "reclaim" &&
              !pooledTask &&
              error instanceof SqliteReclamationRequestRefusedError &&
              claim?.isCurrent() &&
              retainedDatabase?.isOpen &&
              !retainedDatabase.isTransaction
            ) {
              markSqliteReclamationSettled(commitGate);
              return {
                type: "refused",
                operationId,
                settled: true,
              } satisfies SqliteReclamationWorkerMessage;
            }
            failureCleanup = await closeDatabase();
            if (failureCleanup.settled) {
              markSqliteReclamationSettled(commitGate);
            } else {
              throw new AggregateError(
                [error, ...failureCleanup.cleanupWarnings.map((warning) => new Error(warning))],
                "SQLite session reclamation failed and Worker cleanup is incomplete; restart OpenClaw before deleting the owning agent",
                { cause: error },
              );
            }
            throw error;
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
      commitGate = undefined;
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
