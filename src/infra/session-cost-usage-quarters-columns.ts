import {
  QUARTER_MISSING,
  QUARTER_MS,
  QUARTERS,
  Q_TOTALS,
  sectionOf,
  TABLE_OFFSETS,
  TOTALS_WIDTH,
  UNAVAILABLE,
  type UsageCostQuarterBlock,
  type UsageQuarterRange,
} from "./session-cost-usage-quarters.js";
import { createEmptyCostUsageTotals } from "./session-cost-usage-totals.js";
import type { CostUsageTotals } from "./session-cost-usage.types.js";

/**
 * Column primitives for quarter folds. Each column is added by one loop over its
 * typed section (one loop per section type keeps element access monomorphic) into a
 * vector indexed by an owner id, so the work per quarter stays numeric and
 * allocation-free.
 */

const QUARTER_COLUMNS = TABLE_OFFSETS[QUARTERS]!;
export const quarterColumn = (index: number) => QUARTER_COLUMNS + index;

function addOwnedUint32(
  target: Float64Array,
  width: number,
  field: number,
  owners: Int32Array,
  rows: number,
  data: Uint32Array,
  offset: number,
) {
  for (let row = 0; row < rows; row += 1) {
    const owner = owners[row]!;
    if (owner >= 0) {
      const index = owner * width + field;
      target[index] = target[index]! + data[offset + row]!;
    }
  }
}

function addOwnedFloat64(
  target: Float64Array,
  width: number,
  field: number,
  owners: Int32Array,
  rows: number,
  data: Float64Array,
  offset: number,
) {
  for (let row = 0; row < rows; row += 1) {
    const owner = owners[row]!;
    if (owner >= 0) {
      const index = owner * width + field;
      target[index] = target[index]! + data[offset + row]!;
    }
  }
}

/** Add one stored column into `target[owner * width + field]` for rows with an owner. */
export function addColumn(
  target: Float64Array,
  width: number,
  field: number,
  owners: Int32Array,
  rows: number,
  block: UsageCostQuarterBlock,
  columnIndex: number,
) {
  const data = sectionOf(block, columnIndex);
  if (!data) {
    return;
  }
  const offset = block.offsets[columnIndex]!;
  if (data instanceof Uint32Array) {
    addOwnedUint32(target, width, field, owners, rows, data, offset);
  } else {
    addOwnedFloat64(target, width, field, owners, rows, data, offset);
  }
}

function copyUint32(target: Float64Array, rows: number, data: Uint32Array, offset: number) {
  for (let row = 0; row < rows; row += 1) {
    target[row] = data[offset + row]!;
  }
}

function copyFloat64(target: Float64Array, rows: number, data: Float64Array, offset: number) {
  for (let row = 0; row < rows; row += 1) {
    target[row] = data[offset + row]!;
  }
}

/** One stored column as floats in `target[0..rows)`; all-zero columns fill zeros. */
export function readColumn(
  block: UsageCostQuarterBlock,
  columnIndex: number,
  rows: number,
  target: Float64Array,
): Float64Array {
  const data = sectionOf(block, columnIndex);
  if (!data) {
    target.fill(0, 0, rows);
  } else if (data instanceof Uint32Array) {
    copyUint32(target, rows, data, block.offsets[columnIndex]!);
  } else {
    copyFloat64(target, rows, data, block.offsets[columnIndex]!);
  }
  return target;
}

export function valueAt(block: UsageCostQuarterBlock, columnIndex: number, row: number): number {
  const data = sectionOf(block, columnIndex);
  return data ? data[block.offsets[columnIndex]! + row]! : 0;
}

export const growInt32 = (
  current: Int32Array<ArrayBuffer>,
  size: number,
): Int32Array<ArrayBuffer> =>
  current.length >= size ? current : new Int32Array(Math.max(size, current.length * 2));
const growFloat64 = (
  current: Float64Array<ArrayBuffer>,
  size: number,
): Float64Array<ArrayBuffer> =>
  current.length >= size ? current : new Float64Array(Math.max(size, current.length * 2));

// Worker-wide row scratch; every fold call overwrites the rows it reads.
export const scratch = {
  dayOfRow: new Int32Array(256),
  slotOfRow: new Int32Array(256),
  columns: Array.from({ length: 4 }, () => new Float64Array(256)),
  modelSlot: new Int32Array(256),
  modelDaySlot: new Int32Array(256),
  ownedSlot: new Int32Array(256),
  ownedDaySlot: new Int32Array(256),
  quarterModel: new Int32Array(256),
  quarterModelDay: new Int32Array(256),
  toolSlot: new Int32Array(256),
};

export function growColumns(size: number) {
  for (const [index, column] of scratch.columns.entries()) {
    scratch.columns[index] = growFloat64(column, size);
  }
}

function reserveScratch(rows: number) {
  scratch.dayOfRow = growInt32(scratch.dayOfRow, rows);
  scratch.slotOfRow = growInt32(scratch.slotOfRow, rows);
  scratch.quarterModel = growInt32(scratch.quarterModel, rows);
  scratch.quarterModelDay = growInt32(scratch.quarterModelDay, rows);
  growColumns(rows);
}

/**
 * Report day and packed slot of each quarter row; -1 outside the range. Callers check
 * `usageQuartersNeedTranscript` first, so in-range quarters never split a local day.
 * Returns the first and last in-range rows (-1 when none).
 */
export function locateRows(
  block: UsageCostQuarterBlock,
  range: UsageQuarterRange,
): [number, number] {
  const rows = block.rows[QUARTERS]!;
  reserveScratch(rows);
  const { dayOfRow, slotOfRow } = scratch;
  const quarters = readColumn(block, quarterColumn(0), rows, scratch.columns[0]!);
  let first = -1;
  let last = -1;
  for (let row = 0; row < rows; row += 1) {
    const start = block.monthStartMs + quarters[row]! * QUARTER_MS;
    const slot = start < range.startMs || start > range.endMs ? -1 : range.slot(start);
    slotOfRow[row] = slot;
    dayOfRow[row] = slot < 0 ? -1 : slot >> 8;
    if (slot >= 0) {
      if (first < 0) {
        first = row;
      }
      last = row;
    }
  }
  return [first, last];
}

export type MissingEntries = ReadonlyArray<readonly [string, number]>;
export const NO_MISSING: MissingEntries = [];

/** Missing-cost attribution of one owner row; the cursor walks the owner-sorted table once. */
export function readMissing(
  block: UsageCostQuarterBlock,
  table: number,
  cursor: { next: number },
  owner: number,
): MissingEntries {
  const base = TABLE_OFFSETS[table]!;
  const length = block.rows[table]!;
  while (cursor.next < length && valueAt(block, base, cursor.next) < owner) {
    cursor.next += 1;
  }
  const entries: Array<readonly [string, number]> = [];
  for (; cursor.next < length && valueAt(block, base, cursor.next) === owner; cursor.next += 1) {
    entries.push([
      block.missingKeys[valueAt(block, base + 1, cursor.next)]!,
      valueAt(block, base + 2, cursor.next),
    ]);
  }
  return entries;
}

export function addMissing(target: Record<string, number>, entries: MissingEntries): void {
  for (const [key, count] of entries) {
    target[key] = (target[key] ?? 0) + count;
  }
}

export function addMissingTo<K>(
  map: Map<K, Record<string, number>>,
  key: K,
  entries: MissingEntries,
) {
  let counts = map.get(key);
  if (!counts) {
    counts = {};
    map.set(key, counts);
  }
  addMissing(counts, entries);
}

function addTotalsToObject(target: CostUsageTotals, source: Float64Array, offset: number): void {
  target.input += source[offset]!;
  target.output += source[offset + 1]!;
  target.cacheRead += source[offset + 2]!;
  target.cacheWrite += source[offset + 3]!;
  target.totalTokens += source[offset + 4]!;
  target.totalCost += source[offset + 5]!;
  target.inputCost += source[offset + 6]!;
  target.outputCost += source[offset + 7]!;
  target.cacheReadCost += source[offset + 8]!;
  target.cacheWriteCost += source[offset + 9]!;
  target.missingCostEntries += source[offset + 10]!;
  if (source[offset + UNAVAILABLE]) {
    target.usageReport = { state: "unavailable" };
  }
}

const summaryScratch = { days: new Float64Array(64 * TOTALS_WIDTH) };

/** Add in-range quarter totals by local day for `usage.cost`. */
export function addUsageQuartersToDailyTotals(params: {
  block: UsageCostQuarterBlock;
  range: UsageQuarterRange;
  daily: Map<string, CostUsageTotals>;
  totals: CostUsageTotals;
}): void {
  const { block, range } = params;
  const [first, last] = locateRows(block, range);
  if (first < 0) {
    return;
  }
  const { dayOfRow } = scratch;
  const dayCount = range.dates.length;
  summaryScratch.days = growFloat64(summaryScratch.days, dayCount * TOTALS_WIDTH);
  const { days } = summaryScratch;
  // Rows ascend in time, so this block's report days arrive in order.
  const order: number[] = [];
  for (let row = first; row <= last; row += 1) {
    const day = dayOfRow[row]!;
    if (day >= 0 && order.at(-1) !== day) {
      order.push(day);
      days.fill(0, day * TOTALS_WIDTH, (day + 1) * TOTALS_WIDTH);
    }
  }
  const rows = last + 1;
  for (let field = 0; field < TOTALS_WIDTH; field += 1) {
    addColumn(days, TOTALS_WIDTH, field, dayOfRow, rows, block, quarterColumn(Q_TOTALS + field));
  }
  const missing = new Map<number, Record<string, number>>();
  if (block.rows[QUARTER_MISSING]! > 0) {
    const cursor = { next: 0 };
    for (let row = first; row <= last; row += 1) {
      const day = dayOfRow[row]!;
      if (day >= 0) {
        const entries = readMissing(block, QUARTER_MISSING, cursor, row);
        if (entries.length > 0) {
          addMissingTo(missing, day, entries);
        }
      }
    }
  }
  for (const day of order) {
    const date = range.dates[day]!;
    let target = params.daily.get(date);
    if (!target) {
      target = createEmptyCostUsageTotals();
      params.daily.set(date, target);
    }
    for (const totals of [target, params.totals]) {
      addTotalsToObject(totals, days, day * TOTALS_WIDTH);
      const counts = missing.get(day);
      if (counts) {
        addMissing((totals.missingCostByModel ??= {}), Object.entries(counts));
      }
    }
  }
}
