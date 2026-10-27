import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { usageModelIdentity } from "../shared/usage-aggregates.js";
import type { UsageCalendar } from "../shared/usage-calendar.js";
import { computeLatencyStats, type SessionUsageRollupData } from "./session-cost-usage-rollup.js";
import type { CostUsageTotals } from "./session-cost-usage.types.js";

/**
 * Report-only numeric companion of each `session-cost-usage-projection-v2` month
 * partition. The partition producer writes it in the same transaction with the
 * same key and `updated_at`; readers join on both, so a partition rewritten by a
 * build that does not know this scope never pairs with a stale summary.
 */
export const USAGE_COST_QUARTER_SCOPE = "session-cost-usage-quarters-v1";

export const QUARTER_MS = 15 * 60 * 1000;
const FORMAT = 1;

export const TOTAL_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "totalTokens",
  "totalCost",
  "inputCost",
  "outputCost",
  "cacheReadCost",
  "cacheWriteCost",
  "missingCostEntries",
] as const;
export const MESSAGE_FIELDS = [
  "total",
  "user",
  "assistant",
  "toolCalls",
  "toolResults",
  "errors",
] as const;
// Totals vectors: TOTAL_FIELDS in order, then 1 when a usage report was unavailable.
export const TOTALS_WIDTH = 12;
export const TOKENS = 4;
export const COST = 5;
export const UNAVAILABLE = 11;

// Six column tables, each sorted by its owner row:
// quarters: index in month, first/last offsets, totals, messages, latency count/sum/min/max/p95;
// models: quarter row, model id, call count, own totals (0 when they equal the quarter's);
// model totals (owned rows only); tools: quarter row, tool id, count;
// missing-cost attribution for quarters and for owned model totals: owner, key id, count.
export const Q_FIRST = 1;
export const Q_LAST = 2;
export const Q_TOTALS = 3;
export const Q_MESSAGES = Q_TOTALS + TOTALS_WIDTH;
export const Q_LATENCY = Q_MESSAGES + MESSAGE_FIELDS.length;
const TABLE_WIDTHS = [Q_LATENCY + 5, 4, TOTALS_WIDTH, 3, 3, 3] as const;
export const [QUARTERS, MODELS, MODEL_TOTALS, TOOLS, QUARTER_MISSING, MODEL_MISSING] = [
  0, 1, 2, 3, 4, 5,
] as const;
export const TABLE_OFFSETS = TABLE_WIDTHS.map((_, index) =>
  TABLE_WIDTHS.slice(0, index).reduce((sum, width) => sum + width, 0),
);
const COLUMN_COUNT = TABLE_WIDTHS.reduce((sum, width) => sum + width, 0);
const tableOf = (columnIndex: number) =>
  TABLE_OFFSETS.findLastIndex((offset) => offset <= columnIndex);
const COLUMN_TABLES = Uint8Array.from({ length: COLUMN_COUNT }, (_, index) => tableOf(index));
// Columns that may equal the in-order sum of other columns in their table (code "s").
const DERIVED = new Map<number, readonly number[]>([
  [TABLE_OFFSETS[QUARTERS]! + Q_TOTALS + TOKENS, [0, 1, 2, 3].map((i) => Q_TOTALS + i)],
  [TABLE_OFFSETS[QUARTERS]! + Q_TOTALS + COST, [6, 7, 8, 9].map((i) => Q_TOTALS + i)],
  [TABLE_OFFSETS[QUARTERS]! + Q_MESSAGES, [Q_MESSAGES + 1, Q_MESSAGES + 2]],
  [TABLE_OFFSETS[MODEL_TOTALS]! + TOKENS, [0, 1, 2, 3]],
  [TABLE_OFFSETS[MODEL_TOTALS]! + COST, [6, 7, 8, 9]],
]);
// Column codes: "0" all zero, "s" derived, "i" unsigned 32-bit section, "d" float64 section.
type ColumnCode = "0" | "s" | "i" | "d";

export type UsageCostQuarterRow = { valueJson: string; blob: Uint8Array<ArrayBuffer> };

export type UsageCostQuarterBlock = {
  monthStartMs: number;
  rows: readonly number[];
  /** Section of each column: 0 all zero, 1 integers, 2 floats, 3 derived sums. */
  kinds: Uint8Array;
  /** Start of each column inside its section. */
  offsets: Int32Array;
  sections: readonly [undefined, Uint32Array, Float64Array, Float64Array | undefined];
  /** [provider, model] per block model id; null marks a missing part. */
  models: ReadonlyArray<readonly [string | null, string | null]>;
  tools: readonly string[];
  missingKeys: readonly string[];
};

function sumParts(parts: readonly (readonly number[] | undefined)[], row: number): number {
  let sum = 0;
  for (const part of parts) {
    sum += part?.[row] ?? 0;
  }
  return sum;
}

function columnCode(values: readonly number[], parts?: readonly (readonly number[])[]): ColumnCode {
  let integral = true;
  let zero = true;
  let summed = parts !== undefined;
  for (const [row, value] of values.entries()) {
    if (summed && sumParts(parts!, row) !== value) {
      summed = false;
    }
    if (value !== 0) {
      zero = false;
    }
    if (!Number.isInteger(value) || value < 0 || value >= 0x1_0000_0000) {
      integral = false;
    }
  }
  return zero ? "0" : summed ? "s" : integral ? "i" : "d";
}

const align = (offset: number) => Math.ceil(offset / 8) * 8;

const missingEntries = (totals: CostUsageTotals) =>
  JSON.stringify(
    Object.entries(totals.missingCostByModel ?? {}).toSorted(([a], [b]) => a.localeCompare(b)),
  );

function sameTotals(left: CostUsageTotals, right: CostUsageTotals): boolean {
  return (
    TOTAL_FIELDS.every((field) => left[field] === right[field]) &&
    (left.usageReport?.state === "unavailable") === (right.usageReport?.state === "unavailable") &&
    missingEntries(left) === missingEntries(right)
  );
}

/** Encode one month partition's quarter buckets into compact numeric columns. */
export function encodeUsageCostQuarters(
  date: string,
  month: SessionUsageRollupData,
): UsageCostQuarterRow {
  const monthStartMs = monthStart(date);
  const columns = Array.from({ length: COLUMN_COUNT }, (): number[] => []);
  const push = (table: number, values: readonly number[]) => {
    for (const [index, value] of values.entries()) {
      columns[TABLE_OFFSETS[table]! + index]!.push(value);
    }
  };
  const dictionary = <T>(values: T[], index: Map<string, number>, key: string, value: T) => {
    let found = index.get(key);
    if (found === undefined) {
      found = values.length;
      values.push(value);
      index.set(key, found);
    }
    return found;
  };
  const models: Array<[string | null, string | null]> = [];
  const modelIndex = new Map<string, number>();
  const tools: string[] = [];
  const toolIndex = new Map<string, number>();
  const missingKeys: string[] = [];
  const missingIndex = new Map<string, number>();
  const totalsValues = (totals: CostUsageTotals) => [
    ...TOTAL_FIELDS.map((field) => totals[field]),
    totals.usageReport?.state === "unavailable" ? 1 : 0,
  ];
  const pushMissing = (table: number, row: number, totals: CostUsageTotals) => {
    for (const [key, count] of Object.entries(totals.missingCostByModel ?? {})) {
      push(table, [row, dictionary(missingKeys, missingIndex, key, key), count]);
    }
  };
  let ownedModels = 0;
  const buckets = Object.values(month.buckets).toSorted((a, b) => a.timestampMs - b.timestampMs);
  for (const [row, bucket] of buckets.entries()) {
    const latency = computeLatencyStats(bucket.latency);
    push(QUARTERS, [
      (bucket.timestampMs - monthStartMs) / QUARTER_MS,
      (bucket.firstTimestampMs ?? bucket.timestampMs) - bucket.timestampMs,
      (bucket.lastTimestampMs ?? bucket.timestampMs) - bucket.timestampMs,
      ...totalsValues(bucket.totals),
      ...MESSAGE_FIELDS.map((field) => bucket.messageCounts[field]),
      latency?.count ?? 0,
      latency ? bucket.latency.sum : 0,
      latency?.minMs ?? 0,
      latency?.maxMs ?? 0,
      latency?.p95Ms ?? 0,
    ]);
    pushMissing(QUARTER_MISSING, row, bucket.totals);
    for (const model of bucket.models) {
      const id = dictionary(models, modelIndex, usageModelIdentity(model.provider, model.model), [
        model.provider ?? null,
        model.model ?? null,
      ]);
      // A quarter answered by one model usually attributes all of its usage to it.
      const owned = bucket.models.length > 1 || !sameTotals(model.totals, bucket.totals);
      push(MODELS, [row, id, model.count, owned ? 1 : 0]);
      if (owned) {
        push(MODEL_TOTALS, totalsValues(model.totals));
        pushMissing(MODEL_MISSING, ownedModels++, model.totals);
      }
    }
    for (const tool of bucket.tools) {
      push(TOOLS, [row, dictionary(tools, toolIndex, tool.name, tool.name), tool.count]);
    }
  }
  const codes = columns.map((values, index) => {
    const parts = DERIVED.get(index);
    const table = tableOf(index);
    return columnCode(
      values,
      parts?.map((part) => columns[TABLE_OFFSETS[table]! + part]!),
    );
  });
  let integers = 0;
  let floats = 0;
  for (const [index, code] of codes.entries()) {
    if (code === "i") {
      integers += columns[index]!.length;
    } else if (code === "d") {
      floats += columns[index]!.length;
    }
  }
  const floatStart = align(integers * 4);
  const buffer = new ArrayBuffer(floatStart + floats * 8);
  const integerView = new Uint32Array(buffer, 0, integers);
  const floatView = new Float64Array(buffer, floatStart, floats);
  let integerOffset = 0;
  let floatOffset = 0;
  for (const [index, code] of codes.entries()) {
    const values = columns[index]!;
    if (code === "i") {
      integerView.set(values, integerOffset);
      integerOffset += values.length;
    } else if (code === "d") {
      floatView.set(values, floatOffset);
      floatOffset += values.length;
    }
  }
  return {
    valueJson: JSON.stringify({
      format: FORMAT,
      rows: TABLE_WIDTHS.map((_, table) => columns[TABLE_OFFSETS[table]!]!.length),
      columns: codes.join(""),
      models,
      tools,
      missingKeys,
    }),
    blob: new Uint8Array(buffer),
  };
}

const CODE_KINDS: Record<string, number> = { "0": 0, i: 1, d: 2, s: 3 };

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const isCountList = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => Number.isSafeInteger(item) && item >= 0);
const isModelList = (value: unknown): value is Array<[string | null, string | null]> =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      Array.isArray(item) &&
      item.length === 2 &&
      item.every((part) => part === null || typeof part === "string"),
  );

/** Month start from a `YYYY-MM-01` partition date. */
function monthStart(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, 1);
}

/** Decode a stored quarter row; `undefined` marks a row the refresh owner must rebuild. */
export function decodeUsageCostQuarters(
  date: string,
  valueJson: string | null,
  blob: Uint8Array | null,
): UsageCostQuarterBlock | undefined {
  if (valueJson === null || blob === null) {
    return undefined;
  }
  try {
    const header: unknown = JSON.parse(valueJson);
    if (!isRecord(header) || header.format !== FORMAT) {
      return undefined;
    }
    const { rows, columns: codes, models, tools, missingKeys } = header;
    if (
      !isCountList(rows) ||
      rows.length !== TABLE_WIDTHS.length ||
      typeof codes !== "string" ||
      codes.length !== COLUMN_COUNT ||
      !isModelList(models) ||
      !isStringList(tools) ||
      !isStringList(missingKeys)
    ) {
      return undefined;
    }
    const kinds = new Uint8Array(COLUMN_COUNT);
    const offsets = new Int32Array(COLUMN_COUNT);
    const sizes = [0, 0, 0, 0];
    for (let index = 0; index < COLUMN_COUNT; index += 1) {
      const kind = CODE_KINDS[codes[index]!];
      if (kind === undefined || (kind === 3 && !DERIVED.has(index))) {
        return undefined;
      }
      kinds[index] = kind;
      offsets[index] = sizes[kind]!;
      sizes[kind]! += rows[COLUMN_TABLES[index]!]!;
    }
    const floatStart = align(sizes[1]! * 4);
    if (floatStart + sizes[2]! * 8 !== blob.byteLength) {
      return undefined;
    }
    // Typed views need an aligned buffer; SQLite blobs normally own one.
    const source = blob.byteOffset % 8 === 0 ? blob : Uint8Array.from(blob);
    const buffer = source.buffer;
    const sections = [
      undefined,
      new Uint32Array(buffer, source.byteOffset, sizes[1]!),
      new Float64Array(buffer, source.byteOffset + floatStart, sizes[2]!),
      sizes[3]! > 0 ? new Float64Array(sizes[3]!) : undefined,
    ] as const;
    const block: UsageCostQuarterBlock = {
      monthStartMs: monthStart(date),
      rows,
      kinds,
      offsets,
      sections,
      models,
      tools,
      missingKeys,
    };
    // Derived columns sum stored columns of their table, which may follow them.
    const derived = sections[3];
    if (derived) {
      for (const [index, parts] of DERIVED) {
        if (kinds[index] !== 3) {
          continue;
        }
        const table = COLUMN_TABLES[index]!;
        const target = derived.subarray(offsets[index]!, offsets[index]! + rows[table]!);
        for (const part of parts) {
          const sourceColumn = TABLE_OFFSETS[table]! + part;
          const data = sectionOf(block, sourceColumn);
          if (data) {
            addSection(target, data, offsets[sourceColumn]!);
          }
        }
      }
    }
    return block;
  } catch {
    return undefined;
  }
}

/**
 * Report-calendar facts per quarter. `slot` packs an in-range quarter's report day index
 * (into `dates`, first-seen order), local hour and weekday as `day * 256 + hour * 8 +
 * weekday`; -1 marks a quarter that crosses a local day or the range edge.
 */
export type UsageQuarterRange = {
  startMs: number;
  endMs: number;
  dates: string[];
  slot: (quarterStartMs: number) => number;
};

const SPLIT_QUARTER = -1;
const UNKNOWN = -2;
export const slotHour = (slot: number) => (slot >> 3) & 31;
export const slotWeekday = (slot: number) => slot & 7;

export function createUsageQuarterRange(params: {
  startMs?: number;
  endMs?: number;
  calendar: UsageCalendar;
}): UsageQuarterRange {
  const startMs = params.startMs ?? Number.NEGATIVE_INFINITY;
  const endMs = params.endMs ?? Number.POSITIVE_INFINITY;
  const startSplit = Number.isFinite(startMs) && startMs % QUARTER_MS !== 0;
  const endSplit = Number.isFinite(endMs) && (endMs + 1) % QUARTER_MS !== 0;
  // Bounded ranges index facts by quarter; open ranges key them by start time.
  const firstQuarter = Math.floor(startMs / QUARTER_MS) - 1;
  const quarterCount = Math.floor(endMs / QUARTER_MS) - firstQuarter + 2;
  const indexed =
    Number.isFinite(quarterCount) && quarterCount > 0 && quarterCount <= 400_000
      ? new Int32Array(quarterCount).fill(UNKNOWN)
      : undefined;
  const keyed = indexed ? undefined : new Map<number, number>();
  const dates: string[] = [];
  const dayIndex = new Map<string, number>();
  const compute = (quarterStartMs: number): number => {
    const local = params.calendar.at(quarterStartMs);
    // Modern zone offsets and transitions are quarter-hour aligned; others need transcripts.
    if (
      local.minute % 15 !== 0 ||
      local.second !== 0 ||
      (startSplit && quarterStartMs < startMs && startMs < quarterStartMs + QUARTER_MS) ||
      (endSplit && quarterStartMs <= endMs && endMs < quarterStartMs + QUARTER_MS - 1)
    ) {
      return SPLIT_QUARTER;
    }
    let day = dayIndex.get(local.date);
    if (day === undefined) {
      day = dates.length;
      dates.push(local.date);
      dayIndex.set(local.date, day);
    }
    return day * 256 + local.hour * 8 + local.weekday;
  };
  return {
    startMs,
    endMs,
    dates,
    slot(quarterStartMs) {
      if (indexed) {
        const index = quarterStartMs / QUARTER_MS - firstQuarter;
        if (index >= 0 && index < quarterCount) {
          let found = indexed[index]!;
          if (found === UNKNOWN) {
            found = compute(quarterStartMs);
            indexed[index] = found;
          }
          return found;
        }
      }
      let found = keyed?.get(quarterStartMs);
      if (found === undefined) {
        found = compute(quarterStartMs);
        keyed?.set(quarterStartMs, found);
      }
      return found;
    },
  };
}

/** The typed section holding one column, or `undefined` when it is all zero. */
export function sectionOf(
  block: UsageCostQuarterBlock,
  columnIndex: number,
): Uint32Array | Float64Array | undefined {
  switch (block.kinds[columnIndex]) {
    case 1:
      return block.sections[1];
    case 2:
      return block.sections[2];
    case 3:
      return block.sections[3];
    default:
      return undefined;
  }
}

// Separate loops per section type keep each element access monomorphic.
function addUint32(target: Float64Array, data: Uint32Array, offset: number) {
  for (let row = 0; row < target.length; row += 1) {
    target[row] = target[row]! + data[offset + row]!;
  }
}
function addFloat64(target: Float64Array, data: Float64Array, offset: number) {
  for (let row = 0; row < target.length; row += 1) {
    target[row] = target[row]! + data[offset + row]!;
  }
}
function addSection(target: Float64Array, data: Uint32Array | Float64Array, offset: number) {
  if (data instanceof Uint32Array) {
    addUint32(target, data, offset);
  } else {
    addFloat64(target, data, offset);
  }
}

/** True when an in-range quarter with activity crosses a local day or the range edge. */
export function usageQuartersNeedTranscript(
  block: UsageCostQuarterBlock,
  range: UsageQuarterRange,
): boolean {
  const data = sectionOf(block, TABLE_OFFSETS[QUARTERS]!);
  const offset = block.offsets[TABLE_OFFSETS[QUARTERS]!]!;
  for (let row = 0; row < block.rows[QUARTERS]!; row += 1) {
    const start = block.monthStartMs + (data ? data[offset + row]! : 0) * QUARTER_MS;
    if (
      start + QUARTER_MS > range.startMs &&
      start <= range.endMs &&
      range.slot(start) === SPLIT_QUARTER
    ) {
      return true;
    }
  }
  return false;
}
