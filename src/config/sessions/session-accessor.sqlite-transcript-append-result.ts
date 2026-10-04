import type { Result } from "@openclaw/normalization-core/result";
import type {
  TranscriptAppendRefusal,
  TranscriptEventAppendResult,
  TranscriptMessageWriteSnapshot,
  TranscriptWriteSnapshot,
} from "./session-accessor.sqlite-contract.js";

export function isTranscriptMessageAppendCurrentTail(
  snapshot: TranscriptMessageWriteSnapshot<unknown>,
): boolean {
  return (
    snapshot.result !== undefined &&
    snapshot.visibleTail.generation !== null &&
    snapshot.visibleTail.generation === snapshot.after.generation &&
    snapshot.visibleTail.entryId === snapshot.result.messageId
  );
}

export function requireTranscriptEventAppendSnapshot(
  result: Result<TranscriptWriteSnapshot<TranscriptEventAppendResult>, TranscriptAppendRefusal>,
  message: string,
): TranscriptWriteSnapshot<Extract<TranscriptEventAppendResult, { appended: true }>> {
  if (result.ok && result.value.result.appended) {
    return { ...result.value, result: result.value.result };
  }
  const cause = result.ok ? { code: "transcript-event-not-appended" as const } : result.error;
  throw new Error(`${message}: ${cause.code}`, { cause });
}
