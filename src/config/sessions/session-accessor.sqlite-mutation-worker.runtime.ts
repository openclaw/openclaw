import { on, once } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { MessagePort } from "node:worker_threads";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync-cache-state.js";
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
  hasOpenClawAgentCanonicalValidation,
  type OpenClawAgentDatabaseValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import {
  borrowOpenClawAgentDatabase,
  settleOpenClawAgentDatabaseWorkerClose,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAdmission,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
  type OpenClawAgentDatabaseWorkerCloseResult,
  type OpenClawAgentDatabaseWriteAdmission,
} from "../../state/openclaw-agent-db.js";
import type { CanonicalSessionValidationResult } from "./session-accessor.sqlite-contract.js";
import type { SqliteSessionReclamationPlan } from "./session-accessor.sqlite-lifecycle-types.js";
import {
  markSqliteReclamationSettled,
  waitForSqliteReclamationCommit,
} from "./session-accessor.sqlite-reclamation-commit.js";
import type {
  SqliteCanonicalValidationWorkerRequest,
  SqliteReclamationWorkerRequest,
  SqliteReclamationWorkerCloseRequest,
  SqliteReclamationWorkerMessage,
} from "./session-accessor.sqlite-reclamation-worker.js";
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

function withWorkerWriteAdmission<T>(
  port: MessagePort,
  operationId: number,
  databaseOptions: OpenClawAgentDatabaseOptions,
  operation: (database: OpenClawAgentDatabase) => T | Promise<T>,
): Promise<T> {
  let admissionId = 0;
  let finalAdmission = false;
  const withAdmission: OpenClawAgentDatabaseWriteAdmission = async (run) => {
    const requestedId = ++admissionId;
    const admission = await new Promise<{
      allowed: boolean;
      validation?: OpenClawAgentDatabaseValidation;
    }>((resolve, reject) => {
      const receive = (admissionMessage: {
        type: string;
        operationId: number;
        admissionId: number;
        allowed: boolean;
        validation?: OpenClawAgentDatabaseValidation;
      }) => {
        cleanup();
        if (
          admissionMessage.type !== "admission" ||
          admissionMessage.operationId !== operationId ||
          admissionMessage.admissionId !== requestedId
        ) {
          reject(new Error("SQLite reclamation Worker received invalid write admission"));
          return;
        }
        resolve(admissionMessage);
      };
      const closed = () => {
        cleanup();
        reject(new Error("SQLite reclamation parent closed during database admission"));
      };
      const cleanup = () => {
        port.off("message", receive);
        port.off("close", closed);
      };
      port.on("message", receive);
      port.once("close", closed);
      port.postMessage({
        type: "admission-request",
        operationId,
        admissionId: requestedId,
      });
    });
    const value = await run(() => {
      if (!admission.allowed) {
        throw new Error("SQLite reclamation database admission was revoked");
      }
    }, admission.validation);
    if (!finalAdmission) {
      port.postMessage({
        type: "admission-release",
        operationId,
        admissionId: requestedId,
      });
    }
    return value;
  };
  return withOpenClawAgentDatabaseAdmission(databaseOptions, withAdmission, (database) => {
    finalAdmission = true;
    return operation(database);
  });
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
  const { reclaimSqliteFreePages } = await import("./session-history-archive-pruning.js");
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
          // The parent joins the cold transaction, not the subsequent bounded page drain.
          markSqliteReclamationSettled(commitGate);
          if (data.plan.kind !== "cold-restore") {
            await reclaimSqliteFreePages(data.plan.databaseOptions, undefined, { maxPasses: 64 });
          }
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
): Promise<void> {
  // Archive-only operations never load the write/lifecycle graph.
  const { reclaimSqliteSessionInTransaction } =
    await import("./session-accessor.sqlite-reclamation.js");
  let claim: OpenClawAgentDatabaseClaim | undefined;
  let retainedDatabase: DatabaseSync | undefined;
  let lease: OpenClawAgentDatabaseWorkerLeaseReceipt | undefined;
  let commitGate: SharedArrayBuffer | undefined;
  let operationId = 0;
  let failureCleanup: Awaited<ReturnType<typeof settleReclamationDatabase>> | undefined;
  const closeDatabase = async () => {
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
      failureCleanup = undefined;
      const response = await runWithSqliteMutationWorkerCoordination(
        request.coordination,
        operationId,
        databaseOptions,
        async (options) => {
          if (request.type === "close") {
            return {
              type: "closed",
              ...(await closeDatabase()),
            } satisfies SqliteReclamationWorkerMessage;
          }
          commitGate = request.commitGate;
          try {
            claim?.assertCurrent();
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
                              if (!hasOpenClawAgentCanonicalValidation(transactionDatabase)) {
                                canonical.seedCanonicalSessionValidation(transactionDatabase);
                              }
                              authorizeCommit();
                              return {
                                validatedRows: 0,
                                certifiedRows: 0,
                                hasMore:
                                  canonical.hasPendingCanonicalSessionValidation(
                                    transactionDatabase,
                                  ),
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
                            authorizeCommit();
                            return {
                              validatedRows: batch.rows.length,
                              certifiedRows,
                              hasMore:
                                canonical.hasPendingCanonicalSessionValidation(transactionDatabase),
                              oversizedRows: batch.oversizedRows,
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
                  if (!database.db.isOpen || !database.db.isTransaction) {
                    markSqliteReclamationSettled(commitGate);
                  }
                  clearNodeSqliteKyselyCacheForDatabase(database.db);
                }
              },
            );
            return {
              type: "reclaimed",
              operationId,
              result,
              settled: true,
              validation,
            } satisfies SqliteMutationWorkerMessage<typeof result>;
          } catch (error) {
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
        port.close();
        return;
      }
      // The matching settlement releases this victim's admission and all plan buffers.
      if (request.type === "reclaim") {
        request.plan.materializedPlans.length = 0;
      }
      port.postMessage(response);
      commitGate = undefined;
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
    claim?.release();
  }
}
