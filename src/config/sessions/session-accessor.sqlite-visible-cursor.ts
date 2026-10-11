import type { SessionTranscriptVisibleMessageDeltaLimits } from "./session-accessor.sqlite-contract.js";

const VISIBLE_MESSAGE_CURSOR_VERSION = 1;
export const DEFAULT_VISIBLE_MESSAGE_MAX_MESSAGES = 1_000;
export const DEFAULT_VISIBLE_MESSAGE_MAX_BYTES = 1_000_000;
export const MAX_VISIBLE_MESSAGE_MAX_MESSAGES = 10_000;
export const MAX_VISIBLE_MESSAGE_MAX_BYTES = 64 * 1024 * 1024;

const VISIBLE_MESSAGE_DELTA_STARTS = new Set(["transcript", "reset-window"]);

export type VisibleMessageCursor = {
  agentId: string;
  generation: string;
  lastEventSeq: number;
  lastMessagePosition: number;
  /**
   * Present only on reset-window cursors: raw seq of the reset row that opened the
   * window being drained, or -1 when no reset existed when the cursor was created.
   */
  resetBoundarySeq?: number;
  /**
   * Entry id of that reset row, when it has one. Raw seqs restart after a generation
   * rotation, so only the id identifies the drained reset across generations.
   */
  resetBoundaryId?: string;
  sessionId: string;
  version: typeof VISIBLE_MESSAGE_CURSOR_VERSION;
};

export function normalizeVisibleMessageLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${String(maximum)}`);
  }
  return resolved;
}

export function normalizeVisibleDeltaLimits(limits: SessionTranscriptVisibleMessageDeltaLimits) {
  if (limits.start !== undefined && !VISIBLE_MESSAGE_DELTA_STARTS.has(limits.start)) {
    throw new RangeError('start must be "transcript" or "reset-window"');
  }
  return {
    start: limits.start ?? "transcript",
    maxMessages: normalizeVisibleMessageLimit(
      limits.maxMessages,
      DEFAULT_VISIBLE_MESSAGE_MAX_MESSAGES,
      MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
      "maxMessages",
    ),
    maxBytes: normalizeVisibleMessageLimit(
      limits.maxBytes,
      DEFAULT_VISIBLE_MESSAGE_MAX_BYTES,
      MAX_VISIBLE_MESSAGE_MAX_BYTES,
      "maxBytes",
    ),
  };
}

export function encodeVisibleMessageCursor(cursor: VisibleMessageCursor): string {
  // Fixed key order keeps stored cursors byte-identical across releases and lets
  // the parser require exact encoder output.
  const canonical: VisibleMessageCursor = {
    agentId: cursor.agentId,
    generation: cursor.generation,
    sessionId: cursor.sessionId,
    lastEventSeq: cursor.lastEventSeq,
    lastMessagePosition: cursor.lastMessagePosition,
    ...(cursor.resetBoundarySeq !== undefined ? { resetBoundarySeq: cursor.resetBoundarySeq } : {}),
    ...(cursor.resetBoundaryId !== undefined ? { resetBoundaryId: cursor.resetBoundaryId } : {}),
    version: cursor.version,
  };
  return Buffer.from(JSON.stringify(canonical), "utf8").toString("base64url");
}

export function createVisibleMessageCursor(params: {
  agentId: string;
  generation: string;
  sessionId: string;
}): VisibleMessageCursor {
  return {
    ...params,
    lastEventSeq: -1,
    lastMessagePosition: -1,
    version: VISIBLE_MESSAGE_CURSOR_VERSION,
  };
}

export function parseVisibleMessageCursor(value: string): VisibleMessageCursor | undefined {
  // Accept only exact encoder output so aliases and unknown fields cannot resume or be re-emitted.
  // The caller still revalidates this continuation hint against the current scope and projection.
  if (value.length > 4_096) {
    return undefined;
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) {
      return undefined;
    }
    const parsed = JSON.parse(bytes.toString("utf8")) as Partial<VisibleMessageCursor>;
    if (
      parsed.version !== VISIBLE_MESSAGE_CURSOR_VERSION ||
      typeof parsed.agentId !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.generation !== "string" ||
      typeof parsed.lastEventSeq !== "number" ||
      !Number.isSafeInteger(parsed.lastEventSeq) ||
      parsed.lastEventSeq < -1 ||
      typeof parsed.lastMessagePosition !== "number" ||
      !Number.isSafeInteger(parsed.lastMessagePosition) ||
      parsed.lastMessagePosition < -1 ||
      (parsed.lastEventSeq === -1) !== (parsed.lastMessagePosition === -1) ||
      (parsed.resetBoundarySeq !== undefined &&
        (typeof parsed.resetBoundarySeq !== "number" ||
          !Number.isSafeInteger(parsed.resetBoundarySeq) ||
          parsed.resetBoundarySeq < -1)) ||
      (parsed.resetBoundaryId !== undefined &&
        (typeof parsed.resetBoundaryId !== "string" ||
          parsed.resetBoundaryId.length === 0 ||
          parsed.resetBoundarySeq === undefined ||
          parsed.resetBoundarySeq < 0))
    ) {
      return undefined;
    }
    const cursor: VisibleMessageCursor = {
      agentId: parsed.agentId,
      generation: parsed.generation,
      sessionId: parsed.sessionId,
      lastEventSeq: parsed.lastEventSeq,
      lastMessagePosition: parsed.lastMessagePosition,
      ...(parsed.resetBoundarySeq !== undefined
        ? { resetBoundarySeq: parsed.resetBoundarySeq }
        : {}),
      ...(parsed.resetBoundaryId !== undefined ? { resetBoundaryId: parsed.resetBoundaryId } : {}),
      version: parsed.version,
    };
    return encodeVisibleMessageCursor(cursor) === value ? cursor : undefined;
  } catch {
    return undefined;
  }
}
