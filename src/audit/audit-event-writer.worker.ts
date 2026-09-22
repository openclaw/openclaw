import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import {
  runWithOpenClawStateBusyTimeout,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { isOpenClawStateWriteContentionError } from "../state/openclaw-state-ownership.js";
import {
  pruneExpiredAuditEventsInDatabase,
  recordAuditEventInDatabase,
} from "./audit-event-store.js";
import { isOutboundMessageProgressInput } from "./audit-event-types.js";
import {
  formatAuditWriterError,
  formatAuditWriterRequestError,
} from "./audit-event-writer.errors.js";
import type { AuditWriterOperations, AuditWriterResult } from "./audit-event-writer.types.js";
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

/** Execute one FIFO attempt on the shared actor, including fail-fast first use. */
export function executeAuditWriterCommand(
  command: SqliteWorkerCommand<AuditWriterOperations>,
  options: OpenClawStateDatabaseOptions,
  retainDatabase: () => OpenClawStateDatabase,
): AuditWriterResult {
  try {
    return runWithOpenClawStateBusyTimeout(
      () => {
        const database = { ...options, database: retainDatabase() };
        if (command.type === "audit.writer.prune") {
          const maintenance = {
            events: pruneExpiredAuditEventsInDatabase,
            identity: pruneExpiredExecutionIdentityContextsInDatabase,
            decisions: pruneExpiredExecutionDecisionFactsInDatabase,
            progress: pruneExpiredOutboundMessageProgressInDatabase,
          }[command.input];
          return { status: "settled", deleted: maintenance({ database }) };
        }
        const request = command.input;
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
      options,
      0,
    );
  } catch (error) {
    if (isOpenClawStateWriteContentionError(error)) {
      return { status: "retry" };
    }
    return {
      status: "settled",
      error:
        command.type === "audit.writer.process"
          ? formatAuditWriterRequestError(command.input, error)
          : formatAuditWriterError(error),
    };
  }
}
