import type { DatabaseSync } from "node:sqlite";
import { ExecutionDecisionCursorError } from "../audit/execution-decision-receipts.js";
import { inspectExecutionIdentityRunInDatabase } from "../audit/execution-identity-context.js";
import { readConfigSnapshotAuditRecordInDatabase } from "../config/config-journal-snapshot.kernel.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadResult,
} from "./openclaw-state-read.types.js";

export function readStateDiagnosticCommand(
  db: DatabaseSync,
  command: Extract<
    OpenClawStateReadCommand,
    { type: "config.snapshot.read" | "audit.run.inspect" }
  >,
): OpenClawStateReadResult {
  if (command.type === "config.snapshot.read") {
    return {
      type: command.type,
      snapshot: readConfigSnapshotAuditRecordInDatabase(db),
    };
  }
  try {
    return {
      type: command.type,
      result: {
        status: "inspected",
        inspection: inspectExecutionIdentityRunInDatabase(db, command.input),
      },
    };
  } catch (error) {
    if (!(error instanceof ExecutionDecisionCursorError)) {
      throw error;
    }
    return {
      type: command.type,
      result: { status: "invalid-cursor", message: error.message },
    };
  }
}
