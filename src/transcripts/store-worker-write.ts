import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { appendMeetingTranscriptUtterance } from "./store-sqlite.js";
import type { TranscriptWriteOperations } from "./store-worker-contract.js";

export function appendTranscriptInWorker(
  input: TranscriptWriteOperations["transcripts.append"]["input"],
  options: OpenClawStateDatabaseOptions,
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      appendMeetingTranscriptUtterance({ ...input, database: db });
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
    },
    options,
    { operationLabel: "meeting-transcripts.utterance.append" },
  );
}
