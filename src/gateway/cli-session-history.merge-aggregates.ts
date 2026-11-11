// Conservative display-only coverage for stored Claude CLI reply aggregates.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isToolResultBlock } from "../chat/tool-content.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../shared/assistant-display-content.js";
import {
  hasAssistantDisplayableNonTextContent,
  hasTranscriptMediaFacts,
} from "./chat-display-projection.helpers.js";
import { DEDUPE_TIMESTAMP_WINDOW_MS } from "./cli-session-history-index-policy.js";

const CLI_ASSISTANT_IDEMPOTENCY_PREFIX = "cli-assistant:";

type CliAssistantSegment = { text: string };

type LocalTurn = {
  order: number;
  timestamp?: number;
  // A stored external identity is ineligible for text fallback when the import has one.
  externalIdentity?: boolean;
};

type LocalTurnBucket = {
  turns: readonly LocalTurn[];
  cursor: number;
  // Timestamp-sorted indexes into `turns`. Range lookup stays logarithmic when
  // repeated prompts miss the dedupe window.
  timestampedByTime: Array<{ index: number; timestamp: number }>;
  // Remaining turns at or after each index, including externally identified rows.
  allFrom: number[];
  // Remaining turns that text fallback can still accept.
  openFrom: number[];
};

function suffixCounts(
  turns: readonly LocalTurn[],
  include: (turn: LocalTurn) => boolean,
): number[] {
  const counts = Array.from({ length: turns.length + 1 }, () => 0);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    counts[index] = (counts[index + 1] ?? 0) + (turn && include(turn) ? 1 : 0);
  }
  return counts;
}

function createLocalTurnBucket(turns: readonly LocalTurn[]): LocalTurnBucket {
  const timestampedByTime = turns
    .map((turn, index) =>
      turn.timestamp === undefined ? undefined : { index, timestamp: turn.timestamp },
    )
    .filter((entry): entry is { index: number; timestamp: number } => entry !== undefined)
    .toSorted((left, right) =>
      left.timestamp === right.timestamp
        ? left.index - right.index
        : left.timestamp - right.timestamp,
    );
  return {
    turns,
    cursor: 0,
    timestampedByTime,
    allFrom: suffixCounts(turns, () => true),
    openFrom: suffixCounts(turns, (turn) => turn.externalIdentity !== true),
  };
}

// The durable reply keeps its key on the row; older transcript metadata nests it.
export function isCliAssistantAggregateMessage(
  message: unknown,
  role: string | undefined,
): boolean {
  const record = asOptionalRecord(message);
  const key =
    normalizeOptionalString(record?.idempotencyKey) ??
    normalizeOptionalString(asOptionalRecord(record?.["__openclaw"])?.idempotencyKey);
  return role === "assistant" && key?.startsWith(CLI_ASSISTANT_IDEMPOTENCY_PREFIX) === true;
}

// The runtime rewrites this same idempotency key with managed audio and other
// display attachments. Native text never carries those bytes, so text coverage
// must not hide the row that owns them.
export function cliAssistantAggregateOwnsCanonicalAttachments(message: unknown): boolean {
  const record = asOptionalRecord(message);
  if (!record) {
    return false;
  }
  if (hasAssistantDisplayableNonTextContent(record)) {
    return true;
  }
  const display = record[ASSISTANT_DISPLAY_CONTENT_FIELD];
  if (Array.isArray(display) && hasAssistantDisplayableNonTextContent({ content: display })) {
    return true;
  }
  if (hasTranscriptMediaFacts(record)) {
    return true;
  }
  const mediaUrls = asOptionalRecord(record.openclawDelivery)?.mediaUrls;
  return (
    Array.isArray(mediaUrls) &&
    mediaUrls.some((url) => typeof url === "string" && url.trim().length > 0)
  );
}

// Comparable texts are already whitespace-collapsed, so joining with one space
// matches how the producer's "\n"-joined aggregate normalizes.
function findCoveringSegmentRun(
  aggregateText: string,
  segments: readonly CliAssistantSegment[],
  consumed: Set<CliAssistantSegment>,
): CliAssistantSegment[] | undefined {
  for (let start = 0; start < segments.length; start += 1) {
    let acc = "";
    for (let end = start; end < segments.length; end += 1) {
      const segment = segments[end];
      if (!segment || consumed.has(segment)) {
        break;
      }
      acc = acc ? `${acc} ${segment.text}` : segment.text;
      if (acc === aggregateText) {
        return segments.slice(start, end + 1);
      }
      if (acc.length >= aggregateText.length) {
        break;
      }
    }
  }
  return undefined;
}

function isEligibleTurn(
  bucket: LocalTurnBucket,
  index: number,
  excludeExternalIdentity: boolean,
): boolean {
  if (index < bucket.cursor) {
    return false;
  }
  const turn = bucket.turns[index];
  if (!turn) {
    return false;
  }
  return !(excludeExternalIdentity && turn.externalIdentity === true);
}

function firstTimestampIndex(
  entries: ReadonlyArray<{ timestamp: number }>,
  target: number,
  after: boolean,
): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const timestamp = entries[mid]?.timestamp;
    if (timestamp === undefined || (after ? timestamp <= target : timestamp < target)) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function acceptAlignedTurn(
  bucket: LocalTurnBucket,
  index: number,
  acceptedOrder: number,
): number | undefined {
  const order = bucket.turns[index]?.order;
  if (order !== acceptedOrder) {
    return undefined;
  }
  bucket.cursor = index + 1;
  return order;
}

function onlyRemainingTurn(
  bucket: LocalTurnBucket,
  excludeExternalIdentity: boolean,
  acceptedOrder: number,
): number | undefined {
  const counts = excludeExternalIdentity ? bucket.openFrom : bucket.allFrom;
  if ((counts[bucket.cursor] ?? 0) !== 1) {
    return undefined;
  }
  for (let index = bucket.cursor; index < bucket.turns.length; index += 1) {
    if (isEligibleTurn(bucket, index, excludeExternalIdentity)) {
      return acceptAlignedTurn(bucket, index, acceptedOrder);
    }
  }
  return undefined;
}

// Coverage may name only the matcher-accepted row. Repeated prompts inside one
// dedupe window remain ambiguous: choosing the first could hide an older answer.
// Identity-excluded rows never count as candidates for text fallback.
function takeAlignedLocalTurn(
  bucket: LocalTurnBucket,
  timestamp: number | undefined,
  acceptedOrder: number,
  excludeExternalIdentity: boolean,
): number | undefined {
  if (timestamp !== undefined && bucket.timestampedByTime.length > 0) {
    const start = firstTimestampIndex(
      bucket.timestampedByTime,
      timestamp - DEDUPE_TIMESTAMP_WINDOW_MS,
      false,
    );
    const end = firstTimestampIndex(
      bucket.timestampedByTime,
      timestamp + DEDUPE_TIMESTAMP_WINDOW_MS,
      true,
    );
    let matched: number | undefined;
    for (let index = start; index < end; index += 1) {
      const turnIndex = bucket.timestampedByTime[index]?.index;
      if (turnIndex === undefined) {
        continue;
      }
      if (!isEligibleTurn(bucket, turnIndex, excludeExternalIdentity)) {
        continue;
      }
      if (matched !== undefined) {
        return undefined;
      }
      matched = turnIndex;
    }
    if (matched !== undefined) {
      return acceptAlignedTurn(bucket, matched, acceptedOrder);
    }
  }
  return onlyRemainingTurn(bucket, excludeExternalIdentity, acceptedOrder);
}

// A native tool result keeps role "user" when the previous assistant message
// mixed text with tool calls, because coalescing requires a tool-only message.
export function isNativeToolResultMessage(message: unknown): boolean {
  const record = asOptionalRecord(message);
  const content = record?.content;
  if (record?.role !== "user" || !Array.isArray(content) || content.length === 0) {
    return false;
  }
  return content.every((block) => {
    const item = asOptionalRecord(block);
    return item ? isToolResultBlock(item) : false;
  });
}

export type LocalCoverageUser = {
  id: number;
  text: string;
  timestamp: number | null;
  externalIdentity: boolean;
};

type ImportedCoverageNote = {
  role: string | null;
  timestamp: number | null;
  duplicate: boolean;
  claudeAssistant: boolean;
  // Local user row the history matcher already accepted, when it is a user turn.
  matchedLocalTurn?: number;
  // Comparable text of that local row. Resume notes and image captions can differ
  // from the imported text, so coverage must not look the import up again.
  matchedLocalText?: string | null;
  // External identity and image correlation pin one local row. Text matches do not.
  matchedByIdentity?: boolean;
  // Imported external identity makes stored external keys ineligible for text fallback.
  excludeExternalIdentity?: boolean;
  toolResult?: boolean;
  hasText?: boolean;
};

// Callers group by the matcher-accepted turn; each segment covers at most one aggregate.
export function droppedCoveredAggregateIds(params: {
  aggregates: ReadonlyArray<{ id: number; text: string }>;
  segments: ReadonlyArray<CliAssistantSegment>;
}): number[] {
  if (params.aggregates.length === 0 || params.segments.length === 0) {
    return [];
  }
  const consumed = new Set<CliAssistantSegment>();
  const dropped: number[] = [];
  for (const aggregate of params.aggregates) {
    const run = findCoveringSegmentRun(aggregate.text, params.segments, consumed);
    if (run) {
      for (const segment of run) {
        consumed.add(segment);
      }
      dropped.push(aggregate.id);
    }
  }
  return dropped;
}

// Alignment state for the history index. Comparable assistant text stays in the
// temporary SQLite index; this object keeps user-turn buckets only until release.
export function createCliAssistantCoverage(): {
  setLocalUsers(users: readonly LocalCoverageUser[]): void;
  noteImported(entry: ImportedCoverageNote): { segmentTurn?: number };
  release(): void;
} {
  let buckets: Map<string, LocalTurnBucket> | undefined;
  let importedTurn: number | undefined;

  return {
    setLocalUsers(users) {
      const grouped = new Map<string, LocalTurn[]>();
      for (const user of users) {
        const turn: LocalTurn = {
          order: user.id,
          ...(user.timestamp === null ? {} : { timestamp: user.timestamp }),
          ...(user.externalIdentity ? { externalIdentity: true } : {}),
        };
        const existing = grouped.get(user.text);
        if (existing) {
          existing.push(turn);
        } else {
          grouped.set(user.text, [turn]);
        }
      }
      buckets = new Map();
      for (const [text, turns] of grouped) {
        buckets.set(text, createLocalTurnBucket(turns));
      }
      importedTurn = undefined;
    },
    noteImported(entry) {
      if (entry.role === "user") {
        if (entry.toolResult) {
          return {};
        }
        if (entry.matchedByIdentity) {
          importedTurn = entry.matchedLocalTurn;
          return {};
        }
        if (entry.matchedLocalTurn === undefined) {
          importedTurn = undefined;
          return {};
        }
        const bucket = entry.matchedLocalText ? buckets?.get(entry.matchedLocalText) : undefined;
        importedTurn = bucket
          ? takeAlignedLocalTurn(
              bucket,
              entry.timestamp ?? undefined,
              entry.matchedLocalTurn,
              entry.excludeExternalIdentity === true,
            )
          : undefined;
        return {};
      }
      if (
        entry.claudeAssistant &&
        !entry.duplicate &&
        entry.hasText &&
        importedTurn !== undefined
      ) {
        return { segmentTurn: importedTurn };
      }
      return {};
    },
    release() {
      buckets = undefined;
      importedTurn = undefined;
    },
  };
}
