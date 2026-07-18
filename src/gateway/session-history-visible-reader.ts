import {
  readSessionTranscriptVisibleMessagePage,
  type SessionTranscriptReadScope,
} from "../config/sessions/session-accessor.js";
import {
  isSqliteReadTarget,
  resolveTranscriptReadTarget,
  sqliteMessageEventWithSeq,
  toTranscriptReadScope,
} from "./session-transcript-readers.js";

export type ReadVisibleSessionMessagesResult =
  | {
      anchors: Array<{ eventSeq: number; seq: number }>;
      generation: string;
      hasMore: boolean;
      kind: "page";
      messages: unknown[];
      totalMessages: number;
      transcriptPath: string;
    }
  | {
      generation: string;
      kind: "reset";
      reason: "anchor_missing" | "generation_mismatch";
    }
  | { kind: "unsupported" };

/** Reads one SQLite visible-history raw window from the active projection. */
export async function readVisibleSessionMessagesAsync(
  scope: SessionTranscriptReadScope,
  opts: {
    before?: { eventSeq: number; generation: string };
    maxMessages: number;
  },
): Promise<ReadVisibleSessionMessagesResult> {
  const target = resolveTranscriptReadTarget(scope);
  if (!isSqliteReadTarget(target)) {
    return { kind: "unsupported" };
  }
  const result = readSessionTranscriptVisibleMessagePage(toTranscriptReadScope(target), opts);
  if (result.kind === "missing") {
    return { kind: "unsupported" };
  }
  if (result.kind === "reset") {
    return result;
  }
  const entries = result.events.flatMap((entry) => {
    const message = sqliteMessageEventWithSeq(entry);
    return message === undefined ? [] : [{ entry, message }];
  });
  return {
    anchors: entries.map(({ entry }) => ({ eventSeq: entry.eventSeq, seq: entry.seq })),
    generation: result.generation,
    hasMore: result.hasMore,
    kind: "page",
    messages: entries.map(({ message }) => message),
    totalMessages: result.totalMessages,
    transcriptPath: target.sessionFile,
  };
}
