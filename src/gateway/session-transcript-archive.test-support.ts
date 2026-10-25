import type { SessionTranscriptSourceSnapshot } from "./session-transcript-read.types.js";

export function createArchiveSourceSnapshotFixture(): SessionTranscriptSourceSnapshot {
  return {
    indexedSeq: -1,
    activeEventCount: 0,
    totalMessages: 0,
    generation: undefined,
    tailEventSeq: undefined,
    resetSeq: null,
  };
}
