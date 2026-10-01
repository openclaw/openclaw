import {
  runWithOpenClawStateBusyTimeout,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { isOpenClawStateWriteContentionError } from "../state/openclaw-state-ownership.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
  WorkerOperations,
} from "../state/worker-operation-registry.js";
import { listAuditEventsInDatabase } from "./audit-event-read.kernel.js";
import {
  pruneExpiredAuditEventsInDatabase,
  recordAuditEventInDatabase,
} from "./audit-event-store.js";
import type { AuditEventListQuery } from "./audit-event-types.js";
import { isOutboundMessageProgressInput } from "./audit-event-types.js";
import {
  formatAuditWriterError,
  formatAuditWriterRequestError,
} from "./audit-event-writer.errors.js";
import type {
  AuditMaintenanceFamily,
  AuditWriterRequest,
  AuditWriterResult,
} from "./audit-event-writer.types.js";
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

// Keep the first open inside the fail-fast busy-timeout and contention boundary.
function executeAuditAttempt(
  { stateOptions, open }: WorkerOperationContext,
  execute: (
    database: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
  ) => AuditWriterResult,
  formatError: (error: unknown) => string,
): AuditWriterResult {
  const options = stateOptions();
  try {
    return runWithOpenClawStateBusyTimeout(
      () => execute({ ...options, database: open() }),
      options,
      0,
    );
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
  "audit.writer.prune": (input: AuditMaintenanceFamily, context) =>
    executeAuditAttempt(
      context,
      (database) => {
        const maintenance = {
          events: pruneExpiredAuditEventsInDatabase,
          identity: pruneExpiredExecutionIdentityContextsInDatabase,
          decisions: pruneExpiredExecutionDecisionFactsInDatabase,
          progress: pruneExpiredOutboundMessageProgressInDatabase,
        }[input];
        return { status: "settled", deleted: maintenance({ database }) };
      },
      formatAuditWriterError,
    ),
  "audit.writer.process": (request: AuditWriterRequest, context) =>
    executeAuditAttempt(
      context,
      (database) => {
        if (request.type === "record-event") {
          if (isOutboundMessageProgressInput(request.input)) {
            recordOutboundMessageProgressInDatabase(request.input, database);
          } else {
            recordAuditEventInDatabase(request.input, database);
          }
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
    ),
} satisfies WorkerOperationHandlers;

export type AuditWorkerOperations = WorkerOperations<typeof auditOperations>;
export type AuditWriterOperations = Pick<
  AuditWorkerOperations,
  "audit.writer.process" | "audit.writer.prune"
>;
