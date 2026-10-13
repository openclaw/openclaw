import type { DatabaseSync } from "node:sqlite";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { assertOpenClawStateLeaseWorkerOwnedInTransaction } from "../state/openclaw-state-lease-worker.js";
import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease.types.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
} from "../state/worker-operation-registry.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
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

type SessionIdentity = Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">;
type ExportInput = {
  session: SessionIdentity;
  lease?: OpenClawStateLeaseIdentity;
  readOnly?: boolean;
};

function writeTranscript(
  input: { readOnly?: boolean },
  { open, stateOptions }: WorkerOperationContext,
  operationLabel: string,
  write: (db: DatabaseSync) => void,
  exportInput?: ExportInput,
) {
  const options = { database: open(), ...stateOptions(), readOnly: input.readOnly };
  ensureMeetingTranscriptsSchema(options);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const assertWrite = (stage: "transaction" | "commit") => {
        if (exportInput?.lease) {
          const { lease, session } = exportInput;
          if (
            lease.scope !== "meeting-transcript.export" ||
            lease.key !== transcriptSessionExportKey(session)
          ) {
            throw new Error("Transcript export lease does not match its session");
          }
          assertOpenClawStateLeaseWorkerOwnedInTransaction(db, lease);
        } else {
          requestSqliteWorkerOperationAdmission({ stage, facts: undefined });
        }
      };
      assertWrite("transaction");
      write(db);
      assertWrite("commit");
    },
    options,
    { operationLabel },
  );
}

export const transcriptWriteOperations = {
  "transcripts.append": (
    input: Omit<Parameters<typeof appendMeetingTranscriptUtterance>[0], "database"> & {
      readOnly?: boolean;
    },
    context,
  ) =>
    writeTranscript(input, context, "meeting-transcripts.utterance.append", (db) =>
      appendMeetingTranscriptUtterance({ ...input, database: db }),
    ),
  "transcripts.writeSummary": (
    input: {
      session: SessionIdentity;
      summaryValues: Parameters<typeof writeMeetingTranscriptSummaryInDatabase>[2];
      guard?: Parameters<typeof writeMeetingTranscriptSummaryInDatabase>[3];
      readOnly?: boolean;
    },
    context,
  ) => {
    try {
      writeTranscript(input, context, "meeting-transcripts.summary.write", (db) =>
        writeMeetingTranscriptSummaryInDatabase(
          db,
          input.session,
          input.summaryValues,
          input.guard,
        ),
      );
      return { ok: true } as const;
    } catch (error) {
      if (error instanceof TranscriptsSummaryChangedError) {
        return { ok: false, reason: "changed" } as const;
      }
      throw error;
    }
  },
  "transcripts.writeSession": (
    input: Parameters<typeof writeMeetingTranscriptSessionInDatabase>[1] & { readOnly?: boolean },
    context,
  ) => {
    try {
      writeTranscript(input, context, "meeting-transcripts.session.write", (db) =>
        writeMeetingTranscriptSessionInDatabase(db, input),
      );
      return { ok: true } as const;
    } catch (error) {
      if (error instanceof TranscriptsSummaryChangedError) {
        return { ok: false, reason: "changed" } as const;
      }
      if (error instanceof TranscriptSessionConflictError) {
        return { ok: false, reason: "conflict" } as const;
      }
      throw error;
    }
  },
  "transcripts.markPendingExports": (input: ExportInput & { fileNames: string[] }, context) =>
    writeTranscript(
      input,
      context,
      "meeting-transcripts.export.pending",
      (db) => markMeetingTranscriptPendingExportsInDatabase(db, input.session, input.fileNames),
      input,
    ),
  "transcripts.recordExportManifest": (
    input: ExportInput & { exportedHashes: Record<string, string>; removedExports: string[] },
    context,
  ) =>
    writeTranscript(
      input,
      context,
      "meeting-transcripts.export.record",
      (db) =>
        updateMeetingTranscriptExportManifestInDatabase(
          db,
          input.session,
          input.exportedHashes,
          new Set(input.removedExports),
        ),
      input,
    ),
} satisfies WorkerOperationHandlers;
