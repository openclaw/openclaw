import type {
  appendTranscriptEventSnapshotSync,
  TranscriptEventAppendResult,
  TranscriptWriteSnapshot,
} from "./session-accessor.sqlite-transcript-write.js";

export function requireTranscriptEventAppendSnapshot(
  result: ReturnType<typeof appendTranscriptEventSnapshotSync>,
  message: string,
): TranscriptWriteSnapshot<Extract<TranscriptEventAppendResult, { appended: true }>> {
  if (result.ok && result.value.result.appended) {
    return { ...result.value, result: result.value.result };
  }
  const cause = result.ok ? { code: "transcript-event-not-appended" as const } : result.error;
  throw new Error(`${message}: ${cause.code}`, { cause });
}
