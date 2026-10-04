import type {
  ReadSessionMessagesAsyncOptions,
  ReadSessionMessagesResult,
  SessionTranscriptReader,
  SessionTranscriptReadOptions,
  SessionTranscriptReadScope,
} from "./session-transcript-read.types.js";

export const SOURCE_PAGE_MAX_MESSAGES = 128;
export const SOURCE_PAGE_MAX_BYTES = 8 * 1024 * 1024;

export type SessionTranscriptSourceSnapshot = {
  indexedSeq: number;
  activeEventCount: number;
  totalMessages: number;
  generation: string | undefined;
  tailEventSeq: number | undefined;
  resetSeq: number | null;
};

export type SessionTranscriptSourceCursor = {
  snapshot: SessionTranscriptSourceSnapshot;
  position: number;
  messageSeq: number;
} & ({ kind: "kept" | "active" | "off-path" } | { kind: "archive"; path: string; source: string });

export type SessionTranscriptSourcePageOptions = SessionTranscriptReadOptions & {
  mode: "page";
  includeOffPathMessages?: boolean;
  cursor?: SessionTranscriptSourceCursor;
};

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
