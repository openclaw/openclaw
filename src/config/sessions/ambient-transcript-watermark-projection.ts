import type { AmbientTranscriptWatermark, SessionEntry } from "./types.js";

function numericMessageId(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isAmbientTranscriptWatermarkAfter(
  next: Pick<AmbientTranscriptWatermark, "messageId" | "timestampMs">,
  current: AmbientTranscriptWatermark | undefined,
): boolean {
  if (!current) {
    return true;
  }
  if (
    next.timestampMs !== undefined &&
    current.timestampMs !== undefined &&
    next.timestampMs !== current.timestampMs
  ) {
    return next.timestampMs > current.timestampMs;
  }
  const nextMessageId = numericMessageId(next.messageId);
  const currentMessageId = numericMessageId(current.messageId);
  if (nextMessageId !== undefined && currentMessageId !== undefined) {
    return nextMessageId > currentMessageId;
  }
  return (
    (next.timestampMs === undefined || current.timestampMs === undefined) &&
    next.messageId !== current.messageId
  );
}

export function readAmbientTranscriptWatermarkFromEntry(
  entry: Pick<SessionEntry, "ambientTranscriptWatermarks" | "sessionId"> | undefined,
  key: string,
): AmbientTranscriptWatermark | undefined {
  const watermark = entry?.ambientTranscriptWatermarks?.[key];
  // A watermark only vouches for rows in the transcript it was written against.
  // After a session reset those rows live in an archived file the model never
  // reads, so a cross-session (or legacy sessionId-less) watermark must not hide them.
  return watermark?.sessionId === entry?.sessionId ? watermark : undefined;
}

export type AmbientTranscriptWatermarkUpdate = {
  key: string;
  messageId: string;
  timestampMs?: number;
  expectedSessionId?: string;
  now: number;
};

export function projectAmbientTranscriptWatermark(
  entry: SessionEntry,
  input: AmbientTranscriptWatermarkUpdate,
): Partial<SessionEntry> | null {
  // A completed append must never acknowledge rows on a reset successor.
  if (
    !entry.sessionId ||
    (input.expectedSessionId !== undefined && entry.sessionId !== input.expectedSessionId) ||
    !isAmbientTranscriptWatermarkAfter(
      input,
      readAmbientTranscriptWatermarkFromEntry(entry, input.key),
    )
  ) {
    return null;
  }
  return {
    ambientTranscriptWatermarks: {
      ...entry.ambientTranscriptWatermarks,
      [input.key]: {
        sessionId: entry.sessionId,
        messageId: input.messageId,
        ...(input.timestampMs !== undefined ? { timestampMs: input.timestampMs } : {}),
        updatedAt: input.now,
      },
    },
  };
}
