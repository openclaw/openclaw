import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import type {
  MeetingSessionRecord,
  MeetingTranscriptLine,
  MeetingTranscriptSnapshot,
} from "./session-types.js";

type RetainedTranscriptSnapshot = MeetingTranscriptSnapshot & {
  pageEpoch?: string;
  pageNextIndex: number;
};

type TranscriptStreamCursor = {
  pageEpoch?: string;
  pageNextIndex: number;
  tailKeys: string[];
};

type PendingTranscriptLine = {
  cursor: TranscriptStreamCursor;
  line?: MeetingTranscriptLine;
};

type TranscriptSnapshotDelta = {
  commitEmpty: boolean;
  lines: MeetingTranscriptLine[];
  prefixKeys: string[];
  startIndex: number;
};

const ENDED_TRANSCRIPTS_MAX = 4;
const TRANSCRIPT_CURSOR_TAIL = 64;
const TRANSCRIPT_MAX_LINES = 2_000;

function transcriptLineKey(line: MeetingTranscriptLine): string {
  return JSON.stringify([line.at ?? "", line.speaker ?? "", line.text]);
}

function maximalTranscriptOverlap(previousKeys: string[], currentKeys: string[]): number {
  const limit = Math.min(previousKeys.length, currentKeys.length);
  for (let length = limit; length > 0; length -= 1) {
    const previousStart = previousKeys.length - length;
    if (
      currentKeys
        .slice(0, length)
        .every((key, index) => key === previousKeys[previousStart + index])
    ) {
      return length;
    }
  }
  return 0;
}

export class MeetingTranscriptDeliveryError extends Error {
  readonly finalCaptureError?: string;

  constructor(cause: unknown, finalCaptureError?: unknown) {
    super(coerceErrorMessage(cause), { cause });
    this.name = "MeetingTranscriptDeliveryError";
    if (finalCaptureError !== undefined) {
      this.finalCaptureError =
        finalCaptureError instanceof Error
          ? finalCaptureError.message
          : typeof finalCaptureError === "string"
            ? finalCaptureError
            : "unknown final capture error";
    }
  }
}

export class MeetingSessionTranscriptStore<TSession extends MeetingSessionRecord> {
  readonly #transcripts = new Map<string, RetainedTranscriptSnapshot>();
  readonly #captures = new KeyedAsyncQueue();
  readonly #pendingLines = new Map<string, PendingTranscriptLine[]>();
  readonly #retired = new Set<string>();
  readonly #streamCursors = new Map<string, TranscriptStreamCursor>();

  constructor(
    private readonly options: {
      getSession(sessionId: string): TSession | undefined;
      isBrowserSession(session: TSession): boolean;
      isTranscribeSession(session: TSession): boolean;
      hasBrowserTab(session: TSession): boolean;
      capture(
        session: TSession,
        options?: { finalize?: boolean },
      ): Promise<MeetingTranscriptSnapshot | undefined>;
      /** Observe every provider revision before the durable transcript cursor deduplicates lines. */
      onSnapshot?(session: TSession, snapshot: MeetingTranscriptSnapshot): void;
      onLines?(session: TSession, lines: MeetingTranscriptLine[]): Promise<void>;
    },
  ) {}

  async read(
    sessionId: string,
    options: { sinceIndex?: number } = {},
  ): Promise<{
    found: boolean;
    sessionId?: string;
    startIndex?: number;
    nextIndex?: number;
    droppedLines?: number;
    evicted?: boolean;
    lines?: MeetingTranscriptLine[];
  }> {
    const session = this.options.getSession(sessionId);
    if (!session) {
      return { found: false };
    }
    if (!this.options.isTranscribeSession(session)) {
      throw new Error("transcript is only available for transcribe-mode sessions");
    }
    const sinceIndex = options.sinceIndex ?? 0;
    if (!Number.isSafeInteger(sinceIndex) || sinceIndex < 0) {
      throw new Error("sinceIndex must be a non-negative safe integer");
    }
    if (session.state === "active") {
      await this.capture(session);
    }
    const snapshot = this.#transcripts.get(sessionId) ?? { droppedLines: 0, lines: [] };
    const startIndex = Math.max(sinceIndex, snapshot.droppedLines);
    return {
      found: true,
      sessionId,
      startIndex,
      nextIndex: snapshot.droppedLines + snapshot.lines.length,
      droppedLines: snapshot.droppedLines,
      ...(session.transcriptEvicted ? { evicted: true } : {}),
      lines: snapshot.lines.slice(startIndex - snapshot.droppedLines),
    };
  }

  async capture(session: TSession, options: { finalize?: boolean } = {}): Promise<void> {
    try {
      await this.#captures.enqueue(session.id, () => this.#capture(session, options, true));
    } catch (error) {
      if (!(error instanceof MeetingTranscriptDeliveryError)) {
        throw error;
      }
    }
  }

  async captureNotes(session: TSession, options: { finalize?: boolean } = {}): Promise<void> {
    await this.#captures.enqueue(session.id, () => this.#capture(session, options, false));
  }

  async flushPending(session: TSession): Promise<void> {
    await this.#captures.enqueue(session.id, () => this.#flushPending(session));
  }

  async #capture(
    session: TSession,
    options: { finalize?: boolean },
    requireTranscribeMode: boolean,
  ): Promise<void> {
    let pendingError: MeetingTranscriptDeliveryError | undefined;
    try {
      await this.#flushPending(session);
    } catch (error) {
      pendingError = error as MeetingTranscriptDeliveryError;
    }
    if (
      !this.options.isBrowserSession(session) ||
      (requireTranscribeMode && !this.options.isTranscribeSession(session)) ||
      !this.options.hasBrowserTab(session)
    ) {
      if (pendingError) {
        throw pendingError;
      }
      return;
    }
    let snapshot: MeetingTranscriptSnapshot | undefined;
    try {
      snapshot = await this.options.capture(session, options);
    } catch (error) {
      if (pendingError) {
        throw new MeetingTranscriptDeliveryError(pendingError.cause ?? pendingError, error);
      }
      throw error;
    }
    if (snapshot) {
      this.options.onSnapshot?.(session, snapshot);
      if (this.options.isTranscribeSession(session)) {
        this.#merge(session.id, snapshot);
      }
      const pending = this.#pendingLines.get(session.id);
      const cursor = pending?.at(-1)?.cursor ?? this.#streamCursors.get(session.id);
      const delta = this.#snapshotDelta(cursor, snapshot);
      this.#queuePending(session.id, snapshot, delta);
      if (pendingError) {
        throw pendingError;
      }
      await this.#flushPending(session);
    } else if (pendingError) {
      throw pendingError;
    }
  }

  async #flushPending(session: TSession): Promise<void> {
    const pending = this.#pendingLines.get(session.id);
    for (;;) {
      const next = pending?.[0];
      if (!next) {
        break;
      }
      if (next.line) {
        try {
          await this.options.onLines?.(session, [next.line]);
        } catch (error) {
          throw new MeetingTranscriptDeliveryError(error);
        }
      }
      this.#streamCursors.set(session.id, next.cursor);
      pending.shift();
    }
    if (pending?.length === 0) {
      this.#pendingLines.delete(session.id);
    }
  }

  #queuePending(
    sessionId: string,
    snapshot: MeetingTranscriptSnapshot,
    delta: TranscriptSnapshotDelta,
  ): void {
    const pending = this.#pendingLines.get(sessionId) ?? [];
    let tailKeys = delta.prefixKeys;
    for (const [index, line] of delta.lines.entries()) {
      tailKeys = [...tailKeys, transcriptLineKey(line)].slice(-TRANSCRIPT_CURSOR_TAIL);
      pending.push({
        line,
        cursor: {
          pageEpoch: snapshot.epoch,
          pageNextIndex: delta.startIndex + index + 1,
          tailKeys,
        },
      });
    }
    if (delta.lines.length === 0 && delta.commitEmpty) {
      pending.push({
        cursor: {
          pageEpoch: snapshot.epoch,
          pageNextIndex: snapshot.droppedLines + snapshot.lines.length,
          tailKeys,
        },
      });
    }
    // Undelivered rows are the only copy once the browser rolls its caption buffer.
    // Preserve them until durable delivery succeeds; retirement clears the queue.
    this.#pendingLines.set(sessionId, pending);
  }

  retire(sessionId: string): void {
    const snapshot = this.#transcripts.get(sessionId);
    if (snapshot) {
      this.#transcripts.delete(sessionId);
      this.#transcripts.set(sessionId, snapshot);
      this.#retired.delete(sessionId);
      this.#retired.add(sessionId);
    }
    const retainedIds = [...this.#retired]
      .filter((id) => this.#transcripts.has(id))
      .toSorted((left, right) =>
        (this.options.getSession(left)?.updatedAt ?? "").localeCompare(
          this.options.getSession(right)?.updatedAt ?? "",
        ),
      );
    for (const id of retainedIds.slice(0, -ENDED_TRANSCRIPTS_MAX)) {
      this.#transcripts.delete(id);
      this.#retired.delete(id);
      const session = this.options.getSession(id);
      if (session) {
        session.transcriptEvicted = true;
      }
    }
    this.#pendingLines.delete(sessionId);
    this.#streamCursors.delete(sessionId);
  }

  #snapshotDelta(
    previous: TranscriptStreamCursor | undefined,
    snapshot: MeetingTranscriptSnapshot,
  ): TranscriptSnapshotDelta {
    const pageNextIndex = snapshot.droppedLines + snapshot.lines.length;
    if (
      !previous ||
      previous.pageEpoch !== snapshot.epoch ||
      snapshot.droppedLines >= previous.pageNextIndex
    ) {
      return {
        commitEmpty: previous !== undefined,
        lines: snapshot.lines,
        prefixKeys: [],
        startIndex: snapshot.droppedLines,
      };
    }
    if (snapshot.epoch === undefined && previous.pageEpoch === undefined) {
      const previousStartIndex = previous.pageNextIndex - previous.tailKeys.length;
      const overlapStart = Math.max(previousStartIndex, snapshot.droppedLines);
      const overlapEnd = Math.min(previous.pageNextIndex, pageNextIndex);
      const continuation =
        overlapStart < overlapEnd &&
        Array.from(
          { length: overlapEnd - overlapStart },
          (_, offset) => overlapStart + offset,
        ).every(
          (absoluteIndex) =>
            previous.tailKeys[absoluteIndex - previousStartIndex] ===
            transcriptLineKey(snapshot.lines[absoluteIndex - snapshot.droppedLines]!),
        );
      if ((!continuation && snapshot.lines.length > 0) || pageNextIndex < previous.pageNextIndex) {
        const currentKeys = snapshot.lines.map(transcriptLineKey);
        const overlap = maximalTranscriptOverlap(previous.tailKeys, currentKeys);
        return {
          commitEmpty: true,
          lines: snapshot.lines.slice(overlap),
          prefixKeys: previous.tailKeys.slice(previous.tailKeys.length - overlap),
          startIndex: snapshot.droppedLines + overlap,
        };
      }
    }
    if (pageNextIndex <= previous.pageNextIndex) {
      return {
        commitEmpty: false,
        lines: [],
        prefixKeys: previous.tailKeys,
        startIndex: pageNextIndex,
      };
    }
    return {
      commitEmpty: false,
      lines: snapshot.lines.slice(previous.pageNextIndex - snapshot.droppedLines),
      prefixKeys: previous.tailKeys,
      startIndex: previous.pageNextIndex,
    };
  }

  #merge(sessionId: string, snapshot: MeetingTranscriptSnapshot): void {
    const pageNextIndex = snapshot.droppedLines + snapshot.lines.length;
    const retained: RetainedTranscriptSnapshot = this.#transcripts.get(sessionId) ?? {
      droppedLines: snapshot.droppedLines,
      lines: [],
      pageEpoch: snapshot.epoch,
      pageNextIndex: snapshot.droppedLines,
    };
    this.#transcripts.set(sessionId, retained);
    const retainedNextIndex = retained.droppedLines + retained.lines.length;
    const newEpoch = retained.pageEpoch !== snapshot.epoch;
    const previousPageIndex = newEpoch ? 0 : retained.pageNextIndex;
    if (newEpoch || pageNextIndex > previousPageIndex) {
      if (snapshot.droppedLines > previousPageIndex) {
        // A missing page prefix leaves a gap. Keep its contiguous tail without
        // shifting older lines into the new cursor range, including across epochs.
        const pageOffset = retainedNextIndex - previousPageIndex;
        retained.droppedLines = pageOffset + snapshot.droppedLines;
        retained.lines = [...snapshot.lines];
      } else {
        retained.lines.push(...snapshot.lines.slice(previousPageIndex - snapshot.droppedLines));
      }
      retained.pageEpoch = snapshot.epoch;
      retained.pageNextIndex = pageNextIndex;
    }
    const excess = retained.lines.length - TRANSCRIPT_MAX_LINES;
    if (excess > 0) {
      retained.lines.splice(0, excess);
      retained.droppedLines += excess;
    }
  }
}
