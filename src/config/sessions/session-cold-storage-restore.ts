import type { SessionColdWriteRecord } from "./session-cold-storage-records.js";
import {
  mutateSessionColdTranscriptInWorker,
  prepareSessionColdRestoreInWorker,
  type SessionColdMutationPlan,
} from "./session-cold-storage-worker.js";
import type { SessionColdMutationResult } from "./session-cold-storage.types.js";

/** The cold marker owns reads until every bounded, independently admitted unit commits. */
export async function restoreSessionColdTranscriptInWorker(
  plan: Extract<SessionColdMutationPlan, { kind: "cold-restore" }>,
  admit: (run: () => SessionColdMutationResult) => Promise<SessionColdMutationResult>,
  onCommit: Parameters<typeof mutateSessionColdTranscriptInWorker>[2],
  sourceGuard?: Parameters<typeof mutateSessionColdTranscriptInWorker>[3],
): Promise<SessionColdMutationResult> {
  const records = await prepareSessionColdRestoreInWorker(plan);
  const write = (unit: NonNullable<Parameters<typeof mutateSessionColdTranscriptInWorker>[1]>) =>
    admit(() => mutateSessionColdTranscriptInWorker(plan, unit, onCommit, sourceGuard));
  let result: SessionColdMutationResult;
  do {
    result = await write({ phase: "clear" });
    if (!result.restorePending) {
      return result;
    }
  } while (result.restoreCleanupRows === 256);
  let batch: SessionColdWriteRecord[] = [];
  let characters = 0;
  for (const record of records()) {
    batch.push(record);
    if (record.kind === "event") {
      characters += record.row.event_json.length;
    } else if (record.kind === "fts") {
      characters += record.row.text?.length ?? 0;
    }
    if (batch.length === 256 || characters >= 1_048_576) {
      result = await write({ phase: "rows", records: batch });
      if (!result.restorePending) {
        return result;
      }
      batch = [];
      characters = 0;
    }
  }
  if (batch.length) {
    result = await write({ phase: "rows", records: batch });
    if (!result.restorePending) {
      return result;
    }
  }
  return write({ phase: "complete" });
}
