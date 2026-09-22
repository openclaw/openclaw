import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { ensureMeetingTranscriptsSchema } from "./sqlite-schema.js";
import { TranscriptsSummaryChangedError } from "./store-errors.js";
import { writeMeetingTranscriptSummaryInDatabase } from "./store-sqlite-write.js";
import { appendMeetingTranscriptUtterance } from "./store-sqlite.js";
import type { TranscriptWriteCommand, TranscriptWriteOperations } from "./store-worker-contract.js";

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
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        if (command.type === "transcripts.append") {
          appendMeetingTranscriptUtterance({ ...command.input, database: db });
        } else {
          const { session, summaryValues, guard } = command.input;
          writeMeetingTranscriptSummaryInDatabase(db, session, summaryValues, guard);
        }
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      },
      options,
      {
        operationLabel:
          command.type === "transcripts.append"
            ? "meeting-transcripts.utterance.append"
            : "meeting-transcripts.summary.write",
      },
    );
    return command.type === "transcripts.writeSummary" ? { ok: true } : undefined;
  } catch (error) {
    if (
      command.type === "transcripts.writeSummary" &&
      error instanceof TranscriptsSummaryChangedError
    ) {
      return { ok: false, reason: "changed" };
    }
    throw error;
  }
}
