import { assertTransactionUsable } from "../infra/sqlite-transaction.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { isOpenClawStateWriteContentionError } from "../state/openclaw-state-ownership.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
} from "../state/worker-operation-registry.js";
import { listAuditEventsInDatabase } from "./audit-event-read.kernel.js";
import {
  pruneExpiredAuditEventsInDatabase,
  recordAuditEventInDatabase,
  recordAuditRunInDatabase,
} from "./audit-event-store.js";
import type { AuditEventListQuery } from "./audit-event-types.js";
import { isOutboundMessageProgressInput } from "./audit-event-types.js";
import {
  formatAuditWriterError,
  formatAuditWriterRequestError,
} from "./audit-event-writer.errors.js";
import type { AuditWriterRequest, AuditWriterResult } from "./audit-event-writer.types.js";
import {
  pruneExpiredExecutionDecisionFactsInDatabase,
  recordExecutionDecisionFactInDatabase,
} from "./execution-decision-facts.js";
import { processExecutionDecisionWorkInDatabase } from "./execution-decision-work.js";
import {
  processExecutionIdentityAdmissionWorkInDatabase,
  pruneExpiredExecutionIdentityContextsInDatabase,
} from "./execution-identity-context.js";
import {
  pruneExpiredOutboundMessageProgressInDatabase,
  recordOutboundMessageProgressInDatabase,
} from "./message-delivery-progress-store.js";

// Opening can also encounter contention, so it shares the write retry boundary.
function executeAuditAttempt(
  execute: () => AuditWriterResult,
  formatError: (error: unknown) => string,
): AuditWriterResult {
  try {
    return execute();
  } catch (error) {
    if (isOpenClawStateWriteContentionError(error)) {
      return { status: "retry" };
    }
    return { status: "settled", error: formatError(error) };
  }
}

export const auditOperations = {
  "audit.events.list": (input: AuditEventListQuery, { open }) =>
    listAuditEventsInDatabase(open().db, input),
  "audit.writer.prune": (_input: undefined, context) => {
    const results: AuditWriterResult[] = [];
    // Each family keeps its own transaction; only contention stops the ordered pass.
    for (const maintenance of [
      pruneExpiredAuditEventsInDatabase,
      pruneExpiredExecutionIdentityContextsInDatabase,
      pruneExpiredExecutionDecisionFactsInDatabase,
      pruneExpiredOutboundMessageProgressInDatabase,
    ]) {
      const result = executeAuditAttempt(
        () => ({
          status: "settled",
          deleted: maintenance({
            database: { ...context.stateOptions(), database: context.open() },
          }),
        }),
        formatAuditWriterError,
      );
      results.push(result);
      if (result.status === "retry") {
        break;
      }
    }
    return results;
  },
  "audit.writer.process": (requests: AuditWriterRequest[], context) => {
    if (requests.length === 0) {
      return [];
    }
    const results: AuditWriterResult[] = [];
    try {
      const database = { ...context.stateOptions(), database: context.open() };
      const batched = requests.length > 1;
      const plainBatch =
        batched &&
        requests.every(
          (request) => request.type === "record-event" && request.input.kind !== "message",
        );
      const process = () => {
        for (const request of requests) {
          const result = executeAuditAttempt(
            () => {
              if (request.type === "record-event") {
                if (isOutboundMessageProgressInput(request.input)) {
                  recordOutboundMessageProgressInDatabase(request.input, database);
                } else {
                  recordAuditEventInDatabase(request.input, database, request.eventId, plainBatch);
                }
              } else if (request.type === "record-run") {
                recordAuditRunInDatabase(request.start, request.finish, database, request.eventIds);
              } else if (request.type === "record-execution-identity") {
                processExecutionIdentityAdmissionWorkInDatabase(request.work, database);
              } else if (request.type === "record-execution-decision-work") {
                processExecutionDecisionWorkInDatabase(request.work, database);
              } else {
                recordExecutionDecisionFactInDatabase(request.receipt, database);
              }
              return { status: "settled" };
            },
            (error) => formatAuditWriterRequestError(request, error),
          );
          assertTransactionUsable(database.database.db);
          if (batched && !database.database.db.isTransaction) {
            throw new Error("Audit batch transaction was rolled back");
          }
          results.push(result);
          if (result.status === "retry") {
            break;
          }
        }
        return results;
      };
      // Coalesce only queued neighbors; a lone item keeps its owner's autocommit.
      // Multi-statement items keep savepoints; results leave only after outer commit.
      return requests.length === 1
        ? process()
        : runOpenClawStateWriteTransaction(process, database);
    } catch (error) {
      // A failed outer commit invalidates every tentative per-item settlement.
      return isOpenClawStateWriteContentionError(error)
        ? [{ status: "retry" as const }]
        : requests.map((request) => ({
            status: "settled" as const,
            error: formatAuditWriterRequestError(request, error),
          }));
    }
  },
} satisfies WorkerOperationHandlers;

export type AuditWorkerOperations = WorkerOperations<typeof auditOperations>;
export type AuditWriterOperations = Pick<
  AuditWorkerOperations,
  "audit.writer.process" | "audit.writer.prune"
>;
