import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { assertOpenClawStateLeaseWorkerOwnedInTransaction } from "../state/openclaw-state-lease-worker.js";
import { ensureMeetingTranscriptsSchema } from "./sqlite-schema.js";
import { transcriptSessionExportKey } from "./store-artifacts.js";
import { TranscriptSessionConflictError, TranscriptsSummaryChangedError } from "./store-errors.js";
import {
  markMeetingTranscriptPendingExportsInDatabase,
  updateMeetingTranscriptExportManifestInDatabase,
  writeMeetingTranscriptSessionInDatabase,
  writeMeetingTranscriptSummaryInDatabase,
} from "./store-sqlite-write.js";
import { appendMeetingTranscriptUtterance } from "./store-sqlite.js";
import type { TranscriptWriteCommand, TranscriptWriteOperations } from "./store-worker-contract.js";

const operationLabels: Record<TranscriptWriteCommand["type"], string> = {
  "transcripts.append": "meeting-transcripts.utterance.append",
  "transcripts.writeSummary": "meeting-transcripts.summary.write",
  "transcripts.writeSession": "meeting-transcripts.session.write",
  "transcripts.markPendingExports": "meeting-transcripts.export.pending",
  "transcripts.recordExportManifest": "meeting-transcripts.export.record",
};

export function isTranscriptWriteCommand(command: {
  type: string;
}): command is TranscriptWriteCommand {
  return Object.hasOwn(operationLabels, command.type);
}

export function executeTranscriptWrite(
  command: TranscriptWriteCommand,
  target: { database: OpenClawStateDatabase; path: string },
): TranscriptWriteOperations[keyof TranscriptWriteOperations]["output"] {
  const options = {
    ...target,
    env: getSqliteWorkerStateContext().environment,
    readOnly: command.input.readOnly,
  };
  ensureMeetingTranscriptsSchema(options);
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const lease =
          command.type === "transcripts.markPendingExports" ||
          command.type === "transcripts.recordExportManifest"
            ? command.input.lease
            : undefined;
        const assertLease = () => {
          if (!lease) {
            return;
          }
          if (
            lease.scope !== "meeting-transcript.export" ||
            lease.key !== transcriptSessionExportKey(command.input.session)
          ) {
            throw new Error("Transcript export lease does not match its session");
          }
          assertOpenClawStateLeaseWorkerOwnedInTransaction(db, lease);
        };
        if (lease) {
          assertLease();
        } else {
          requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        }
        switch (command.type) {
          case "transcripts.append":
            appendMeetingTranscriptUtterance({ ...command.input, database: db });
            break;
          case "transcripts.writeSummary": {
            const { session, summaryValues, guard } = command.input;
            writeMeetingTranscriptSummaryInDatabase(db, session, summaryValues, guard);
            break;
          }
          case "transcripts.writeSession":
            writeMeetingTranscriptSessionInDatabase(db, command.input);
            break;
          case "transcripts.markPendingExports":
            markMeetingTranscriptPendingExportsInDatabase(
              db,
              command.input.session,
              command.input.fileNames,
            );
            break;
          case "transcripts.recordExportManifest":
            updateMeetingTranscriptExportManifestInDatabase(
              db,
              command.input.session,
              command.input.exportedHashes,
              new Set(command.input.removedExports),
            );
            break;
        }
        if (lease) {
          assertLease();
        } else {
          requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        }
      },
      options,
      { operationLabel: operationLabels[command.type] },
    );
    return command.type === "transcripts.writeSummary" ||
      command.type === "transcripts.writeSession"
      ? { ok: true }
      : undefined;
  } catch (error) {
    if (
      (command.type === "transcripts.writeSummary" ||
        command.type === "transcripts.writeSession") &&
      error instanceof TranscriptsSummaryChangedError
    ) {
      return { ok: false, reason: "changed" };
    }
    if (
      command.type === "transcripts.writeSession" &&
      error instanceof TranscriptSessionConflictError
    ) {
      return { ok: false, reason: "conflict" };
    }
    throw error;
  }
}
