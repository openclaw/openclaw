import type { SessionTranscriptMessageEvent } from "../config/sessions/session-accessor.js";

type VisibleMessagePageMetadata = {
  anchors: Array<{ eventSeq: number; rawSeq: number; visibleSeq: number }>;
  generation: string;
};

export type ReadRecentSessionMessagesResult = {
  messages: unknown[];
  transcriptPath?: string;
  totalMessages: number;
  visibleCursorPage?: VisibleMessagePageMetadata;
};

/** Builds cursor anchors from one atomically read active-projection page. */
export function buildVisiblePageMeta(page: {
  events: SessionTranscriptMessageEvent[];
  generation?: string;
}): VisibleMessagePageMetadata | undefined {
  return page.generation
    ? {
        anchors: page.events.map((entry) => ({
          eventSeq: entry.seq - 1,
          rawSeq: entry.seq,
          visibleSeq: entry.messagePosition + 1,
        })),
        generation: page.generation,
      }
    : undefined;
}
