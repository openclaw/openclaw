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

export type LocalTurn = {
  order: number;
  timestamp?: number;
  // A stored external identity is ineligible for text fallback when the import has one.
  externalIdentity?: boolean;
};

export type LocalTurnBucket = {
  turns: LocalTurn[];
  cursor: number;
  // Timestamp-sorted indexes into `turns`. Range lookup stays logarithmic when
  // repeated prompts miss the dedupe window.
  timestampedByTime: Array<{ index: number; timestamp: number }>;
  // Remaining turns at or after each index, including externally identified rows.
  allFrom: number[];
  // Remaining turns that text fallback can still accept.
  openFrom: number[];
  // Timestamp-index probes plus in-window candidates. Untimestamped buckets stay at 0.
  visits: number;
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

export function createLocalTurnBucket(turns: readonly LocalTurn[]): LocalTurnBucket {
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
    turns: turns.map((turn) => ({ ...turn })),
    cursor: 0,
    timestampedByTime,
    allFrom: suffixCounts(turns, () => true),
    openFrom: suffixCounts(turns, (turn) => turn.externalIdentity !== true),
    visits: 0,
  };
}

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

type AlignLocalTurnOptions = {
  // Coverage may name only the local row the history matcher already accepted.
  acceptedOrder?: number;
  // Text fallback skips rows that already carry a different external identity.
  excludeExternalIdentity?: boolean;
};

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
  bucket: LocalTurnBucket,
  after: boolean,
): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const timestamp = entries[mid]?.timestamp;
    bucket.visits += 1;
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
  acceptedOrder: number | undefined,
): number | undefined {
  const order = bucket.turns[index]?.order;
  if (order === undefined || (acceptedOrder !== undefined && order !== acceptedOrder)) {
    return undefined;
  }
  bucket.cursor = index + 1;
  return order;
}

function onlyRemainingTurn(
  bucket: LocalTurnBucket,
  excludeExternalIdentity: boolean,
  acceptedOrder: number | undefined,
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

// Picks the local turn an imported user row duplicates. A timestamp names a
// turn only when exactly one eligible candidate sits inside the dedupe window.
// The first of several prompts a minute apart is not that turn: equal-text replies
// would then hide an earlier answer the import never covered. Without a unique
// timestamp, the only safe alignment is a single remaining eligible candidate.
// Ambiguity yields undefined, which leaves every aggregate in that turn alone.
// The result must be the matcher-accepted row when one was supplied. Rows the
// text fallback excludes are not candidates, and a miss does not walk every
// timestamped prompt outside the window.
export function takeAlignedLocalTurn(
  bucket: LocalTurnBucket,
  timestamp: number | undefined,
  options?: AlignLocalTurnOptions,
): number | undefined {
  const excludeExternalIdentity = options?.excludeExternalIdentity === true;
  const acceptedOrder = options?.acceptedOrder;
  if (timestamp !== undefined && bucket.timestampedByTime.length > 0) {
    const start = firstTimestampIndex(
      bucket.timestampedByTime,
      timestamp - DEDUPE_TIMESTAMP_WINDOW_MS,
      bucket,
      false,
    );
    const end = firstTimestampIndex(
      bucket.timestampedByTime,
      timestamp + DEDUPE_TIMESTAMP_WINDOW_MS,
      bucket,
      true,
    );
    let matched: number | undefined;
    for (let index = start; index < end; index += 1) {
      const turnIndex = bucket.timestampedByTime[index]?.index;
      if (turnIndex === undefined) {
        continue;
      }
      bucket.visits += 1;
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

// Compares one turn's aggregate and segment texts. Callers load those strings in
// bounded batches and drop them; this does not retain the inputs.
export function droppedCoveredAggregateIds(params: {
  aggregates: ReadonlyArray<{ id: number; text: string }>;
  segments: ReadonlyArray<{ text: string }>;
}): number[] {
  if (params.aggregates.length === 0 || params.segments.length === 0) {
    return [];
  }
  const aggregates: ComparableHistoryMessage[] = params.aggregates.map((aggregate) => ({
    message: { idempotencyKey: `${CLI_ASSISTANT_IDEMPOTENCY_PREFIX}indexed` },
    order: aggregate.id,
    hasCliImageMentions: false,
    turn: 0,
    role: "assistant",
    text: aggregate.text,
  }));
  const segments: ComparableHistoryMessage[] = params.segments.map((segment, index) => ({
    message: {},
    order: index,
    hasCliImageMentions: false,
    turn: 0,
    importedCliAssistantSegment: true,
    role: "assistant",
    text: segment.text,
  }));
  const kept = new Set(
    dropCoveredCliAssistantAggregates([...aggregates, ...segments]).filter(
      (entry) => !entry.importedCliAssistantSegment,
    ),
  );
  const dropped: number[] = [];
  for (const aggregate of aggregates) {
    if (!kept.has(aggregate)) {
      dropped.push(aggregate.order);
    }
  }
  return dropped;
}

// Alignment state for the history index. Comparable assistant text stays in the
// temporary SQLite index; this object keeps user-turn buckets only until release.
export function createCliAssistantCoverage(): {
  setLocalUsers(users: readonly LocalCoverageUser[]): void;
  noteImported(entry: ImportedCoverageNote): { segmentTurn?: number };
  alignmentExaminations(): number;
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
          ? takeAlignedLocalTurn(bucket, entry.timestamp ?? undefined, {
              acceptedOrder: entry.matchedLocalTurn,
              excludeExternalIdentity: entry.excludeExternalIdentity === true,
            })
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
    alignmentExaminations() {
      if (!buckets) {
        return 0;
      }
      let total = 0;
      for (const bucket of buckets.values()) {
        total += bucket.visits;
      }
      return total;
    },
    release() {
      buckets = undefined;
      importedTurn = undefined;
    },
  };
}
