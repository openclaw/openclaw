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

export function createResetKeptTailTranscriptFixture() {
  const message = (id: string, parentId: string | null, role: string, content: string) => ({
    type: "message",
    id,
    parentId,
    message: { role, content },
  });
  return [
    message("old", null, "user", "old"),
    message("kept-user", "old", "user", "kept question"),
    message("kept-tool", "kept-user", "toolResult", "hidden tool"),
    message("kept-assistant", "kept-tool", "assistant", "kept answer"),
    {
      type: "reset",
      id: "reset-boundary",
      parentId: "kept-assistant",
      timestamp: "2026-07-22T00:00:00.000Z",
      reason: "new",
      firstKeptEntryId: "kept-user",
    },
    message("post-reset", "reset-boundary", "user", "new turn"),
  ];
}
