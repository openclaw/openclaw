import type {
  ReadSessionMessagesAsyncOptions,
  ReadSessionMessagesResult,
  SessionTranscriptReader,
  SessionTranscriptReadOptions,
  SessionTranscriptReadScope,
  SessionTranscriptSourceCursor,
  SessionTranscriptSourcePageOptions,
} from "./session-transcript-read.types.js";

export const SOURCE_PAGE_MAX_MESSAGES = 128;
export const SOURCE_PAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Unbounded anchor reads may come back shorter only for older pages that still return an event
 * before the anchor; callers drop the anchor and continue from the oldest returned event. Other
 * shapes (newer/around, or an anchor-only result) would read as an end of history, so they refuse.
 */
export function assertUnboundedAnchorPageUsable(
  options: { maxBytes?: number; direction?: "older" | "newer" },
  page: { start: number; readStart: number; endExclusive: number },
): void {
  if (options.maxBytes !== undefined || page.start === page.readStart) {
    return;
  }
  if (options.direction === "older" && page.start < page.endExclusive - 1) {
    return;
  }
  throw new Error(
    `Transcript history page exceeds the ${SOURCE_PAGE_MAX_BYTES}-byte limit; request a smaller limit`,
  );
}

export class SessionTranscriptSourceMessageTooLargeError extends Error {
  readonly code = "TRANSCRIPT_SOURCE_MESSAGE_TOO_LARGE";

  constructor() {
    super(`Transcript source message exceeds the ${SOURCE_PAGE_MAX_BYTES}-byte page limit`);
    this.name = "SessionTranscriptSourceMessageTooLargeError";
  }
}

type SourceReader = SessionTranscriptReader["readSessionMessagesWithSourceAsync"];

/** Each pull releases its snapshot before the consumer or the next worker request runs. */
export async function* iterateSessionTranscriptSourcePages(
  read: SourceReader,
  scope: SessionTranscriptReadScope,
  options: Omit<SessionTranscriptSourcePageOptions, "mode" | "cursor"> = {},
  signal?: AbortSignal,
): AsyncGenerator<ReadSessionMessagesResult> {
  let cursor: SessionTranscriptSourceCursor | undefined;
  do {
    signal?.throwIfAborted();
    const page = await read(scope, { ...options, mode: "page", cursor }, signal);
    signal?.throwIfAborted();
    yield page;
    cursor = page.nextCursor;
  } while (cursor);
}

/** Array contracts (plugin hooks and model context) collect the same bounded source pages. */
export async function collectSessionTranscriptMessages(
  read: SourceReader,
  scope: SessionTranscriptReadScope,
  options: Extract<ReadSessionMessagesAsyncOptions, { mode: "full" }> &
    SessionTranscriptReadOptions,
): Promise<unknown[]> {
  const messages: unknown[] = [];
  for await (const page of iterateSessionTranscriptSourcePages(read, scope, options)) {
    for (const message of page.messages) {
      messages.push(message);
    }
  }
  return messages;
}
