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
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "MeetingTranscriptDeliveryError";
  }
}

export class MeetingSessionTranscriptStore<TSession extends MeetingSessionRecord> {
  readonly #transcripts = new Map<string, RetainedTranscriptSnapshot>();
  readonly #captures = new Map<string, Promise<void>>();
  readonly #finalizing = new Set<string>();
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
    if (session.state === "active" && !this.#finalizing.has(session.id)) {
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

  startFinalizing(sessionId: string): void {
    this.#finalizing.add(sessionId);
  }

  finishFinalizing(sessionId: string): void {
    this.#finalizing.delete(sessionId);
  }

  async capture(session: TSession, options: { finalize?: boolean } = {}): Promise<void> {
    try {
      await this.#capture(session, options, true);
    } catch (error) {
      if (!(error instanceof MeetingTranscriptDeliveryError)) {
        throw error;
      }
    }
  }

  async captureNotes(session: TSession, options: { finalize?: boolean } = {}): Promise<void> {
    await this.#capture(session, options, false);
  }

  async #capture(
    session: TSession,
    options: { finalize?: boolean },
    requireTranscribeMode: boolean,
  ): Promise<void> {
    // Live reads, periodic notes, and finalization share this per-session chain.
    // Keep cursor reads inside it so overlapping snapshots cannot deliver twice.
    const previous = this.#captures.get(session.id) ?? Promise.resolve();
    const capture = previous
      .catch(() => {})
      .then(async () => {
        if (
          !this.options.isBrowserSession(session) ||
          (requireTranscribeMode && !this.options.isTranscribeSession(session)) ||
          !this.options.hasBrowserTab(session)
        ) {
          return;
        }
        const snapshot = await this.options.capture(session, options);
        if (snapshot) {
          if (this.options.isTranscribeSession(session)) {
            this.#merge(session.id, snapshot);
          }
          const delta = this.#snapshotDelta(this.#streamCursors.get(session.id), snapshot);
          let tailKeys = [...delta.prefixKeys];
          for (const [index, line] of delta.lines.entries()) {
            try {
              await this.options.onLines?.(session, [line]);
            } catch (error) {
              throw new MeetingTranscriptDeliveryError(error);
            }
            tailKeys = [...tailKeys, transcriptLineKey(line)].slice(-TRANSCRIPT_CURSOR_TAIL);
            this.#streamCursors.set(session.id, {
              pageEpoch: snapshot.epoch,
              pageNextIndex: delta.startIndex + index + 1,
              tailKeys,
            });
          }
          if (delta.lines.length === 0 && delta.commitEmpty) {
            this.#streamCursors.set(session.id, {
              pageEpoch: snapshot.epoch,
              pageNextIndex: snapshot.droppedLines + snapshot.lines.length,
              tailKeys: delta.prefixKeys,
            });
          }
        }
      });
    this.#captures.set(session.id, capture);
    try {
      await capture;
    } finally {
      if (this.#captures.get(session.id) === capture) {
        this.#captures.delete(session.id);
      }
    }
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
    this.#streamCursors.delete(sessionId);
  }

  #snapshotDelta(
    previous: TranscriptStreamCursor | undefined,
    snapshot: MeetingTranscriptSnapshot,
  ): {
    commitEmpty: boolean;
    lines: MeetingTranscriptLine[];
    prefixKeys: string[];
    startIndex: number;
  } {
    const pageNextIndex = snapshot.droppedLines + snapshot.lines.length;
    if (!previous || previous.pageEpoch !== snapshot.epoch) {
      return {
        commitEmpty: previous !== undefined,
        lines: snapshot.lines,
        prefixKeys: [],
        startIndex: snapshot.droppedLines,
      };
    }
    if (snapshot.droppedLines >= previous.pageNextIndex) {
      return {
        commitEmpty: true,
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
    const retained = this.#transcripts.get(sessionId);
    if (!retained) {
      const excess = Math.max(0, snapshot.lines.length - TRANSCRIPT_MAX_LINES);
      // Keep the page's absolute next cursor while retaining only its bounded tail.
      // Advancing droppedLines preserves stable indices for the retained lines.
      this.#transcripts.set(sessionId, {
        droppedLines: snapshot.droppedLines + excess,
        lines: excess > 0 ? snapshot.lines.slice(excess) : snapshot.lines,
        pageEpoch: snapshot.epoch,
        pageNextIndex,
      });
      return;
    }
    const retainedNextIndex = retained.droppedLines + retained.lines.length;
    if (retained.pageEpoch !== snapshot.epoch) {
      if (snapshot.droppedLines > 0) {
        // A new page epoch with an already-trimmed prefix leaves a cursor gap.
        // Keep only its contiguous tail so older lines never move to new indices.
        retained.droppedLines = retainedNextIndex + snapshot.droppedLines;
        retained.lines = [...snapshot.lines];
      } else {
        retained.lines.push(...snapshot.lines);
      }
      retained.pageEpoch = snapshot.epoch;
      retained.pageNextIndex = pageNextIndex;
    } else if (pageNextIndex > retained.pageNextIndex) {
      if (snapshot.droppedLines > retained.pageNextIndex) {
        // Preserve the accumulated cross-epoch offset, but discard the stale segment
        // before the page gap instead of shifting it under the new cursor range.
        const pageOffset = retainedNextIndex - retained.pageNextIndex;
        retained.droppedLines = pageOffset + snapshot.droppedLines;
        retained.lines = [...snapshot.lines];
      } else {
        retained.lines.push(
          ...snapshot.lines.slice(retained.pageNextIndex - snapshot.droppedLines),
        );
      }
      retained.pageNextIndex = pageNextIndex;
    }
    const excess = retained.lines.length - TRANSCRIPT_MAX_LINES;
    if (excess > 0) {
      retained.lines.splice(0, excess);
      retained.droppedLines += excess;
    }
  }
}
