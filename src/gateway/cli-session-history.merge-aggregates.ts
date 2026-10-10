// CLI history covered-aggregate helpers.
// Drops stored cli-assistant aggregates covered by imported segment runs.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isToolResultBlock } from "../chat/tool-content.js";

const DEDUPE_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
const CLI_ASSISTANT_IDEMPOTENCY_PREFIX = "cli-assistant:";

export type ComparableHistoryMessage = {
  message: unknown;
  order: number;
  externalIdentityKey?: string;
  hasCliImageMentions: boolean;
  cliImageTurnKey?: string;
  // Local user row (by order) that anchors this row's turn; undefined when unknown.
  turn?: number;
  importedCliAssistantSegment?: boolean;
  role?: string;
  text?: string;
  driftNoteText?: string;
  timestamp?: number;
};

type CliAssistantSegment = ComparableHistoryMessage & { text: string };

export type LocalTurnBucket = {
  turns: Array<{ order: number; timestamp: number | undefined }>;
  cursor: number;
  // Indexes into `turns` that carry a timestamp. Untimestamped prompts are not
  // revisited when a timestamped import fails to name one of them.
  timestamped: number[];
  timestampedCursor: number;
  // Candidate examinations. Stays flat for repeated misses against untimestamped prompts.
  visits: number;
};

export function compareHistoryMessages(
  a: ComparableHistoryMessage,
  b: ComparableHistoryMessage,
): number {
  if (a.timestamp !== undefined && b.timestamp !== undefined && a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  return a.order - b.order;
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

function isCliAssistantAggregate(entry: ComparableHistoryMessage): boolean {
  return isCliAssistantAggregateMessage(entry.message, entry.role);
}

function hasComparableText(entry: ComparableHistoryMessage): entry is CliAssistantSegment {
  return typeof entry.text === "string" && entry.text.length > 0;
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

// The durable `cli-assistant:<runId>` row and its imported segments share
// nothing but their turn (the CLI transcript never sees the runId), and turn
// membership comes from each source's own order, never from timestamps.
// Each segment stands in for one aggregate at most.
export function dropCoveredCliAssistantAggregates(
  entries: ComparableHistoryMessage[],
): ComparableHistoryMessage[] {
  const segmentsByTurn = new Map<number, CliAssistantSegment[]>();
  const aggregates: Array<[number, CliAssistantSegment]> = [];
  for (const entry of entries) {
    if (entry.turn === undefined || !hasComparableText(entry)) {
      continue;
    }
    if (entry.importedCliAssistantSegment) {
      segmentsByTurn.set(entry.turn, [...(segmentsByTurn.get(entry.turn) ?? []), entry]);
    } else if (isCliAssistantAggregate(entry)) {
      aggregates.push([entry.turn, entry]);
    }
  }
  const dropped = new Set<ComparableHistoryMessage>();
  const consumed = new Set<CliAssistantSegment>();
  for (const [turn, aggregate] of aggregates) {
    const run = findCoveringSegmentRun(aggregate.text, segmentsByTurn.get(turn) ?? [], consumed);
    if (run) {
      run.forEach((segment) => consumed.add(segment));
      dropped.add(aggregate);
    }
  }
  return dropped.size === 0 ? entries : entries.filter((entry) => !dropped.has(entry));
}

function advanceBucketCursor(bucket: LocalTurnBucket, next: number): void {
  bucket.cursor = next;
  while (
    bucket.timestampedCursor < bucket.timestamped.length &&
    (bucket.timestamped[bucket.timestampedCursor] ?? -1) < next
  ) {
    bucket.timestampedCursor += 1;
  }
}

// Picks the local turn an imported user row duplicates. A timestamp names a
// turn only when exactly one candidate sits inside the dedupe window. The
// first of several prompts a minute apart is not that turn: equal-text replies
// would then hide an earlier answer the import never covered. Without a unique
// timestamp, the only safe alignment is a single remaining candidate.
// Ambiguity yields undefined, which leaves every aggregate in that turn alone.
// Untimestamped prompts are not scanned again on later timestamped misses.
export function takeAlignedLocalTurn(
  bucket: LocalTurnBucket,
  timestamp: number | undefined,
): number | undefined {
  if (timestamp !== undefined && bucket.timestampedCursor < bucket.timestamped.length) {
    let matched: number | undefined;
    for (let i = bucket.timestampedCursor; i < bucket.timestamped.length; i += 1) {
      const turnIndex = bucket.timestamped[i];
      if (turnIndex === undefined || turnIndex < bucket.cursor) {
        continue;
      }
      const candidate = bucket.turns[turnIndex];
      bucket.visits += 1;
      if (
        candidate?.timestamp !== undefined &&
        Math.abs(candidate.timestamp - timestamp) <= DEDUPE_TIMESTAMP_WINDOW_MS
      ) {
        if (matched !== undefined) {
          return undefined;
        }
        matched = turnIndex;
      }
    }
    if (matched !== undefined) {
      advanceBucketCursor(bucket, matched + 1);
      return bucket.turns[matched]?.order;
    }
  }
  if (bucket.turns.length - bucket.cursor !== 1) {
    return undefined;
  }
  const only = bucket.turns[bucket.cursor];
  advanceBucketCursor(bucket, bucket.cursor + 1);
  return only?.order;
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

type LocalCoverageNote = {
  id: number;
  role: string | null;
  text: string | null;
  timestamp: number | null;
  aggregate: boolean;
};

type ImportedCoverageNote = {
  role: string | null;
  text: string | null;
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
  toolResult?: boolean;
};

// The in-memory merge walked source order while deduping. The history index
// does that walk in SQLite, so coverage is recorded alongside it and applied
// before ordinals are assigned.
export function createCliAssistantCoverage(): {
  noteLocal(entry: LocalCoverageNote): void;
  noteImported(entry: ImportedCoverageNote): void;
  coveredAggregateIds(): ReadonlySet<number>;
} {
  const locals: LocalCoverageNote[] = [];
  const aggregates: ComparableHistoryMessage[] = [];
  const segments: ComparableHistoryMessage[] = [];
  let buckets: Map<string, LocalTurnBucket> | undefined;
  let importedTurn: number | undefined;

  const ensureBuckets = () => {
    if (buckets) {
      return buckets;
    }
    buckets = new Map();
    let turn: number | undefined;
    // The history reader loads local pages newest first and appends each deferred
    // boundary row later. Insertion order is not conversation order; the local
    // id is the canonical source sequence.
    const ordered = locals.toSorted((left, right) => left.id - right.id);
    for (const local of ordered) {
      if (local.role === "user") {
        turn = local.id;
        if (local.text) {
          const item = { order: local.id, timestamp: local.timestamp ?? undefined };
          const bucket = buckets.get(local.text);
          if (bucket) {
            if (item.timestamp !== undefined) {
              bucket.timestamped.push(bucket.turns.length);
            }
            bucket.turns.push(item);
          } else {
            buckets.set(local.text, {
              turns: [item],
              cursor: 0,
              timestamped: item.timestamp === undefined ? [] : [0],
              timestampedCursor: 0,
              visits: 0,
            });
          }
        }
      }
      if (local.aggregate && local.text && turn !== undefined) {
        aggregates.push({
          message: { idempotencyKey: `${CLI_ASSISTANT_IDEMPOTENCY_PREFIX}indexed` },
          order: local.id,
          hasCliImageMentions: false,
          turn,
          role: "assistant",
          text: local.text,
        });
      }
    }
    return buckets;
  };

  return {
    noteLocal(entry) {
      locals.push(entry);
    },
    noteImported(entry) {
      const localTurns = ensureBuckets();
      if (entry.role === "user") {
        if (entry.toolResult) {
          return;
        }
        if (entry.matchedByIdentity) {
          importedTurn = entry.matchedLocalTurn;
          return;
        }
        const bucket = entry.matchedLocalText ? localTurns.get(entry.matchedLocalText) : undefined;
        importedTurn = bucket
          ? takeAlignedLocalTurn(bucket, entry.timestamp ?? undefined)
          : undefined;
        return;
      }
      if (entry.claudeAssistant && !entry.duplicate && entry.text && importedTurn !== undefined) {
        segments.push({
          message: {},
          order: segments.length,
          hasCliImageMentions: false,
          turn: importedTurn,
          importedCliAssistantSegment: true,
          role: "assistant",
          text: entry.text,
        });
      }
    },
    coveredAggregateIds() {
      if (aggregates.length === 0 || segments.length === 0) {
        return new Set();
      }
      const kept = new Set(
        dropCoveredCliAssistantAggregates([...aggregates, ...segments]).filter(
          (entry) => !entry.importedCliAssistantSegment,
        ),
      );
      const dropped = new Set<number>();
      for (const aggregate of aggregates) {
        if (!kept.has(aggregate)) {
          dropped.add(aggregate.order);
        }
      }
      return dropped;
    },
  };
}
