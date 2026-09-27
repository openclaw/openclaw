import type { DatabaseSync } from "node:sqlite";
import { ExecutionDecisionCursorError } from "../audit/execution-decision-receipts.js";
import { inspectExecutionIdentityRunInDatabase } from "../audit/execution-identity-context.js";
import { readConfigSnapshotAuditRecordInDatabase } from "../config/config-journal-snapshot.kernel.js";
import {
  readDebugProxyCaptureBlob,
  readDebugProxyCaptureSessionEvents,
} from "../proxy-capture/store-readonly.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadResult,
} from "./openclaw-state-read.types.js";

type StateDiagnosticCommand = Extract<
  OpenClawStateReadCommand,
  {
    type:
      | "capture.readOnlyEvents"
      | "capture.readOnlyBlob"
      | "config.snapshot.read"
      | "audit.run.inspect";
  }
>;

export function isStateDiagnosticCommand(
  command: OpenClawStateReadCommand,
): command is StateDiagnosticCommand {
  return (
    command.type === "capture.readOnlyEvents" ||
    command.type === "capture.readOnlyBlob" ||
    command.type === "config.snapshot.read" ||
    command.type === "audit.run.inspect"
  );
}

export function readStateDiagnosticCommand(
  db: DatabaseSync,
  command: StateDiagnosticCommand,
): OpenClawStateReadResult {
  if (command.type === "capture.readOnlyEvents") {
    return {
      type: command.type,
      events: readDebugProxyCaptureSessionEvents(db, command.sessionId, command.limit),
    };
  }
  if (command.type === "capture.readOnlyBlob") {
    return { type: command.type, blob: readDebugProxyCaptureBlob(db, command.blobId) };
  }
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
