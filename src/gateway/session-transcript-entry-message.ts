import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { TranscriptDisplayPosition } from "../chat/transcript-display-position.js";
import type { SessionTranscriptMessageEvent } from "../config/sessions/session-accessor.sqlite-projection-read.js";
import { isVisibleTranscriptRecord } from "../sessions/transcript-visible-record.js";

/** Attach OpenClaw metadata to a transcript message without dropping existing metadata. */
export function attachOpenClawTranscriptMeta(
  message: unknown,
  meta: Record<string, unknown>,
): unknown {
  const record = asOptionalRecord(message);
  if (!record) {
    return message;
  }
  const existing = asOptionalRecord(record["__openclaw"]) ?? {};
  return {
    ...record,
    __openclaw: {
      ...existing,
      ...meta,
    },
  };
}

export function readTranscriptMessageIdempotencyKey(message: unknown): string | undefined {
  return readNonBlankString(asOptionalRecord(message)?.idempotencyKey);
}

/** Stored compaction summaries are written capped; the exact-message read stays bounded too. */
const MAX_COMPACTION_SUMMARY_CHARS = 16_000;

/** A summary that exceeds the stored cap is withheld instead of returning unbounded text. */
function readBoundedCompactionSummary(record: Record<string, unknown>): string | undefined {
  const summary = readNonBlankString(record.summary);
  return summary && summary.length <= MAX_COMPACTION_SUMMARY_CHARS ? summary : undefined;
}

export function sqliteMessageEventWithSeq(
  entry: Pick<SessionTranscriptMessageEvent, "event" | "seq" | "displayPosition">,
  options?: { includeCompactionSummary?: boolean },
): unknown {
  return projectTranscriptEntryMessage(entry.event, entry.seq, entry.displayPosition, options);
}

/** Project one stored transcript entry onto the client-visible chat history shape. */
export function projectTranscriptEntryMessage(
  entry: unknown,
  seq: number,
  transcriptPosition?: TranscriptDisplayPosition,
  options?: { includeCompactionSummary?: boolean },
): unknown {
  if (!isVisibleTranscriptRecord(entry)) {
    return null;
  }
  const record = entry;
  if (record.message) {
    const recordTimestampMs =
      typeof record.timestamp === "string"
        ? Date.parse(record.timestamp)
        : typeof record.timestamp === "number"
          ? record.timestamp
          : Number.NaN;
    const idempotencyKey = readTranscriptMessageIdempotencyKey(record.message);
    return attachOpenClawTranscriptMeta(record.message, {
      ...(typeof record.id === "string" ? { id: record.id } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(Number.isFinite(recordTimestampMs) ? { recordTimestampMs } : {}),
      transcriptPosition,
      seq,
    });
  }
  const parsedTimestamp =
    typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  if (record.type === "custom_message") {
    return attachOpenClawTranscriptMeta(
      {
        role: "custom",
        customType: record.customType,
        content: record.content,
        display: record.display,
        details: record.details,
        timestamp: parsedTimestamp,
      },
      {
        ...(typeof record.id === "string" ? { id: record.id } : {}),
        recordTimestampMs: parsedTimestamp,
        transcriptPosition,
        seq,
      },
    );
  }
  if (record.type !== "compaction" && record.type !== "reset") {
    return null;
  }
  const kind = record.type;
  const compactionIdentity =
    kind === "compaction" ? asOptionalRecord(record["__openclaw"]) : undefined;
  // The summary is only reachable through an exact-message read: history pages stay
  // unchanged, and a page-level compaction marker never carries the retained text.
  const compactionSummary =
    kind === "compaction" && options?.includeCompactionSummary
      ? readBoundedCompactionSummary(record)
      : undefined;
  return {
    role: "system",
    content: [{ type: "text", text: kind === "compaction" ? "Compaction" : "Reset" }],
    timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now(),
    __openclaw: {
      kind,
      id: typeof record.id === "string" ? record.id : undefined,
      ...(typeof compactionIdentity?.runId === "string" ? { runId: compactionIdentity.runId } : {}),
      ...(typeof compactionIdentity?.itemId === "string"
        ? { itemId: compactionIdentity.itemId }
        : {}),
      ...(kind === "compaction" &&
      typeof record.tokensBefore === "number" &&
      Number.isFinite(record.tokensBefore)
        ? { tokensBefore: record.tokensBefore }
        : {}),
      ...(kind === "compaction" &&
      typeof record.tokensAfter === "number" &&
      Number.isFinite(record.tokensAfter)
        ? { tokensAfter: record.tokensAfter }
        : {}),
      ...(compactionSummary ? { summary: compactionSummary } : {}),
      transcriptPosition,
      seq,
    },
  };
}
