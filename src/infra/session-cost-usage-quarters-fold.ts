import { ROW, type createUsageOverviewBatchBuilder } from "./session-cost-usage-overview-batch.js";
import {
  addColumn,
  addMissing,
  addMissingTo,
  growColumns,
  growInt32,
  locateRows,
  NO_MISSING,
  quarterColumn,
  readColumn,
  readMissing,
  scratch,
  valueAt,
} from "./session-cost-usage-quarters-columns.js";
import {
  COST,
  MESSAGE_FIELDS,
  MODEL_MISSING,
  MODEL_TOTALS,
  MODELS,
  Q_FIRST,
  Q_LAST,
  Q_LATENCY,
  Q_MESSAGES,
  Q_TOTALS,
  QUARTER_MISSING,
  QUARTER_MS,
  sectionOf,
  slotHour,
  slotWeekday,
  TABLE_OFFSETS,
  TOKENS,
  TOOLS,
  TOTAL_FIELDS,
  TOTALS_WIDTH,
  type UsageCostQuarterBlock,
  type UsageQuarterRange,
} from "./session-cost-usage-quarters.js";
import type { SessionUsageRollupData } from "./session-cost-usage-rollup.js";

/**
 * Folds quarter rows into packed overview rows: matrices indexed by report day,
 * call-wide model id and call-wide tool id, reset per family.
 */

// Per-day vector: totals, messages (6), latency count/sum/min/max/p95.
const DAY_MESSAGES = TOTALS_WIDTH;
const DAY_LATENCY = DAY_MESSAGES + MESSAGE_FIELDS.length;
const DAY_WIDTH = DAY_LATENCY + 5;
// Per-model vector: totals and call count.
const MODEL_COUNT = TOTALS_WIDTH;
const MODEL_WIDTH = TOTALS_WIDTH + 1;
// Per day and model: tokens, cost, count.
const DM_WIDTH = 3;
// Offsets into the hour facet values.
const HOUR_TOKENS = 0;
const WEEKDAY_TOKENS = 24;
const HOUR_MESSAGES = 31;
const HOUR_ERRORS = 55;

/** Call-wide ids for model pairs and tool names, so per-row sums index typed vectors. */
function createIds() {
  const providers = new Map<string | null, Map<string | null, number>>();
  const models: Array<readonly [string | null, string | null]> = [];
  const toolIds = new Map<string, number>();
  const tools: string[] = [];
  return {
    models,
    tools,
    model(provider: string | null, model: string | null): number {
      let byModel = providers.get(provider);
      if (!byModel) {
        byModel = new Map();
        providers.set(provider, byModel);
      }
      let id = byModel.get(model);
      if (id === undefined) {
        id = models.length;
        models.push([provider, model]);
        byModel.set(model, id);
      }
      return id;
    },
    tool(name: string): number {
      let id = toolIds.get(name);
      if (id === undefined) {
        id = tools.length;
        tools.push(name);
        toolIds.set(name, id);
      }
      return id;
    },
  };
}

/** Tracks touched entries of a zero-initialized vector so a reset clears only them. */
class TouchedSet {
  marks = new Uint8Array(64);
  list: number[] = [];
  add(index: number): boolean {
    if (index >= this.marks.length) {
      const grown = new Uint8Array(Math.max(index + 1, this.marks.length * 2));
      grown.set(this.marks);
      this.marks = grown;
    }
    if (this.marks[index]) {
      return false;
    }
    this.marks[index] = 1;
    this.list.push(index);
    return true;
  }
  clear() {
    for (const index of this.list) {
      this.marks[index] = 0;
    }
    this.list = [];
  }
}

/**
 * Folds the quarter rows of each family (one or more session instances) into one packed
 * overview row. One fold serves a whole worker call; `finishInto` resets it.
 */
export function createUsageOverviewFold(range: UsageQuarterRange) {
  const ids = createIds();
  let dayCapacity = 32;
  let modelCapacity = 8;
  let toolCapacity = 32;
  let days = new Float64Array(dayCapacity * DAY_WIDTH);
  let models = new Float64Array(modelCapacity * MODEL_WIDTH);
  let dayModels = new Float64Array(dayCapacity * modelCapacity * DM_WIDTH);
  let tools = new Float64Array(toolCapacity);
  const touchedDays = new TouchedSet();
  const touchedModels = new TouchedSet();
  let touchedDayModels = new TouchedSet();
  const touchedTools = new TouchedSet();
  // Untimestamped usage has no report day; it adds to row totals only.
  const extraTotals = new Float64Array(TOTALS_WIDTH);
  const extraMessages = new Float64Array(MESSAGE_FIELDS.length);
  const hours = new Float64Array(ROW.HOUR_VALUES);
  let precise = false;
  let quarters = 0;
  let firstActivity = Number.NaN;
  let lastActivity = Number.NaN;
  let computedAt = Number.NaN;
  let staleSince = Number.NaN;
  type FamilyMissing = {
    row?: Record<string, number>;
    days: Map<number, Record<string, number>>;
    models: Map<number, Record<string, number>>;
  };
  let missing: FamilyMissing | undefined;

  // Day and model counts grow while a call discovers dates and models.
  function reserve() {
    const dayCount = range.dates.length;
    const modelCount = ids.models.length;
    if (dayCount > dayCapacity || modelCount > modelCapacity) {
      const nextDays = Math.max(dayCapacity, dayCount > dayCapacity ? dayCount * 2 : 0);
      const nextModels = Math.max(modelCapacity, modelCount > modelCapacity ? modelCount * 2 : 0);
      const grownDays = new Float64Array(nextDays * DAY_WIDTH);
      grownDays.set(days);
      days = grownDays;
      const grownModels = new Float64Array(nextModels * MODEL_WIDTH);
      grownModels.set(models);
      models = grownModels;
      const grownDayModels = new Float64Array(nextDays * nextModels * DM_WIDTH);
      const touched = new TouchedSet();
      for (const key of touchedDayModels.list) {
        const day = Math.floor(key / modelCapacity);
        const model = key % modelCapacity;
        const next = day * nextModels + model;
        grownDayModels.set(
          dayModels.subarray(key * DM_WIDTH, (key + 1) * DM_WIDTH),
          next * DM_WIDTH,
        );
        touched.add(next);
      }
      dayModels = grownDayModels;
      touchedDayModels = touched;
      dayCapacity = nextDays;
      modelCapacity = nextModels;
    }
    if (ids.tools.length > toolCapacity) {
      toolCapacity = ids.tools.length * 2;
      const grown = new Float64Array(toolCapacity);
      grown.set(tools);
      tools = grown;
    }
  }

  function missingState(): FamilyMissing {
    return (missing ??= { days: new Map(), models: new Map() });
  }

  function addModels(block: UsageCostQuarterBlock, rows: number) {
    const length = block.rows[MODELS]!;
    if (length === 0) {
      return;
    }
    const global = block.models.map(([provider, model]) => ids.model(provider, model));
    reserve();
    scratch.modelSlot = growInt32(scratch.modelSlot, length);
    scratch.modelDaySlot = growInt32(scratch.modelDaySlot, length);
    scratch.ownedSlot = growInt32(scratch.ownedSlot, length);
    scratch.ownedDaySlot = growInt32(scratch.ownedDaySlot, length);
    growColumns(length);
    const { dayOfRow, modelSlot, modelDaySlot, ownedSlot, ownedDaySlot } = scratch;
    const { quarterModel, quarterModelDay } = scratch;
    const modelRows = readColumn(block, TABLE_OFFSETS[MODELS]!, length, scratch.columns[0]!);
    const modelIds = readColumn(block, TABLE_OFFSETS[MODELS]! + 1, length, scratch.columns[1]!);
    const owned = readColumn(block, TABLE_OFFSETS[MODELS]! + 3, length, scratch.columns[2]!);
    quarterModel.fill(-1, 0, rows);
    quarterModelDay.fill(-1, 0, rows);
    let ownedCount = 0;
    let shared = false;
    for (let index = 0; index < length; index += 1) {
      const row = modelRows[index]!;
      const day = row < rows ? dayOfRow[row]! : -1;
      let model = -1;
      let key = -1;
      if (day >= 0) {
        model = global[modelIds[index]!]!;
        key = day * modelCapacity + model;
        touchedModels.add(model);
        touchedDayModels.add(key);
      }
      modelSlot[index] = model;
      modelDaySlot[index] = key;
      if (owned[index] === 1) {
        ownedSlot[ownedCount] = model;
        ownedDaySlot[ownedCount] = key;
        ownedCount += 1;
      } else if (day >= 0) {
        // A shared row repeats its quarter's totals; a quarter has at most one.
        quarterModel[row] = model;
        quarterModelDay[row] = key;
        shared = true;
      }
    }
    const callCount = TABLE_OFFSETS[MODELS]! + 2;
    addColumn(models, MODEL_WIDTH, MODEL_COUNT, modelSlot, length, block, callCount);
    addColumn(dayModels, DM_WIDTH, 2, modelDaySlot, length, block, callCount);
    const ownedTotals = TABLE_OFFSETS[MODEL_TOTALS]!;
    for (let field = 0; field < TOTALS_WIDTH; field += 1) {
      addColumn(models, MODEL_WIDTH, field, ownedSlot, ownedCount, block, ownedTotals + field);
      if (shared) {
        const column = quarterColumn(Q_TOTALS + field);
        addColumn(models, MODEL_WIDTH, field, quarterModel, rows, block, column);
      }
    }
    for (const [target, field] of [
      [0, TOKENS],
      [1, COST],
    ] as const) {
      addColumn(dayModels, DM_WIDTH, target, ownedDaySlot, ownedCount, block, ownedTotals + field);
      if (shared) {
        const column = quarterColumn(Q_TOTALS + field);
        addColumn(dayModels, DM_WIDTH, target, quarterModelDay, rows, block, column);
      }
    }
  }

  function addTools(block: UsageCostQuarterBlock, rows: number) {
    const length = block.rows[TOOLS]!;
    if (length === 0) {
      return;
    }
    const global = block.tools.map((name) => ids.tool(name));
    reserve();
    scratch.toolSlot = growInt32(scratch.toolSlot, length);
    growColumns(length);
    const { dayOfRow, toolSlot } = scratch;
    const toolRows = readColumn(block, TABLE_OFFSETS[TOOLS]!, length, scratch.columns[0]!);
    const toolIds = readColumn(block, TABLE_OFFSETS[TOOLS]! + 1, length, scratch.columns[1]!);
    for (let index = 0; index < length; index += 1) {
      const row = toolRows[index]!;
      if (row < rows && dayOfRow[row]! >= 0) {
        const tool = global[toolIds[index]!]!;
        toolSlot[index] = tool;
        touchedTools.add(tool);
      } else {
        toolSlot[index] = -1;
      }
    }
    addColumn(tools, 1, 0, toolSlot, length, block, TABLE_OFFSETS[TOOLS]! + 2);
  }

  function addBlockMissing(block: UsageCostQuarterBlock, first: number, last: number) {
    if (block.rows[QUARTER_MISSING] === 0 && block.rows[MODEL_MISSING] === 0) {
      return;
    }
    const state = missingState();
    const { dayOfRow } = scratch;
    const global = block.models.map(([provider, model]) => ids.model(provider, model));
    const modelLength = block.rows[MODELS]!;
    const modelRows = TABLE_OFFSETS[MODELS]!;
    const quarterCursor = { next: 0 };
    const modelCursor = { next: 0 };
    let ownedIndex = 0;
    let modelIndex = 0;
    for (let row = 0; row <= last; row += 1) {
      const day = row >= first ? dayOfRow[row]! : -1;
      const rowMissing =
        day >= 0 ? readMissing(block, QUARTER_MISSING, quarterCursor, row) : NO_MISSING;
      if (rowMissing.length > 0) {
        addMissing((state.row ??= {}), rowMissing);
        addMissingTo(state.days, day, rowMissing);
      }
      for (
        ;
        modelIndex < modelLength && valueAt(block, modelRows, modelIndex) === row;
        modelIndex += 1
      ) {
        const isOwned = valueAt(block, modelRows + 3, modelIndex) === 1;
        const entries =
          day < 0
            ? NO_MISSING
            : isOwned
              ? readMissing(block, MODEL_MISSING, modelCursor, ownedIndex)
              : rowMissing;
        if (entries.length > 0) {
          addMissingTo(state.models, global[valueAt(block, modelRows + 1, modelIndex)]!, entries);
        }
        if (isOwned) {
          ownedIndex += 1;
        }
      }
    }
  }

  return {
    addInstance(instance: { computedAt: number; staleSince?: number }) {
      computedAt = Number.isNaN(computedAt)
        ? instance.computedAt
        : Math.min(computedAt, instance.computedAt);
      if (instance.staleSince !== undefined) {
        staleSince = Number.isNaN(staleSince)
          ? instance.staleSince
          : Math.min(staleSince, instance.staleSince);
      }
    },
    addBlock(block: UsageCostQuarterBlock): void {
      const [first, last] = locateRows(block, range);
      if (first < 0) {
        return;
      }
      reserve();
      const { dayOfRow, slotOfRow } = scratch;
      const rows = last + 1;
      for (let row = first; row <= last; row += 1) {
        const day = dayOfRow[row]!;
        if (day >= 0 && touchedDays.add(day)) {
          days[day * DAY_WIDTH + DAY_LATENCY + 2] = Number.POSITIVE_INFINITY;
        }
      }
      for (let field = 0; field < TOTALS_WIDTH; field += 1) {
        addColumn(days, DAY_WIDTH, field, dayOfRow, rows, block, quarterColumn(Q_TOTALS + field));
      }
      for (let field = 0; field < MESSAGE_FIELDS.length; field += 1) {
        const column = quarterColumn(Q_MESSAGES + field);
        addColumn(days, DAY_WIDTH, DAY_MESSAGES + field, dayOfRow, rows, block, column);
      }
      if (sectionOf(block, quarterColumn(Q_LATENCY))) {
        for (let field = 0; field < 2; field += 1) {
          const column = quarterColumn(Q_LATENCY + field);
          addColumn(days, DAY_WIDTH, DAY_LATENCY + field, dayOfRow, rows, block, column);
        }
        const [count, min, max, p95] = [0, 2, 3, 4].map((field, index) =>
          readColumn(block, quarterColumn(Q_LATENCY + field), rows, scratch.columns[index]!),
        );
        for (let row = first; row <= last; row += 1) {
          const day = dayOfRow[row]!;
          if (day >= 0 && count![row]! > 0) {
            const base = day * DAY_WIDTH + DAY_LATENCY;
            days[base + 2] = Math.min(days[base + 2]!, min![row]!);
            days[base + 3] = Math.max(days[base + 3]!, max![row]!);
            days[base + 4] = Math.max(days[base + 4]!, p95![row]!);
          }
        }
      }
      // Report-local hour facets.
      const tokens = readColumn(block, quarterColumn(Q_TOTALS + TOKENS), rows, scratch.columns[0]!);
      const messages = readColumn(block, quarterColumn(Q_MESSAGES), rows, scratch.columns[1]!);
      const errors = readColumn(block, quarterColumn(Q_MESSAGES + 5), rows, scratch.columns[2]!);
      for (let row = first; row <= last; row += 1) {
        const slot = slotOfRow[row]!;
        if (slot < 0) {
          continue;
        }
        quarters += 1;
        const hour = slotHour(slot);
        const quarterTokens = tokens[row]!;
        if (quarterTokens > 0) {
          precise = true;
          hours[HOUR_TOKENS + hour] = hours[HOUR_TOKENS + hour]! + quarterTokens;
          const weekday = WEEKDAY_TOKENS + slotWeekday(slot);
          hours[weekday] = hours[weekday]! + quarterTokens;
        }
        hours[HOUR_MESSAGES + hour] = hours[HOUR_MESSAGES + hour]! + messages[row]!;
        hours[HOUR_ERRORS + hour] = hours[HOUR_ERRORS + hour]! + errors[row]!;
      }
      // Rows ascend in time and offsets stay inside their quarter.
      const quarterStart = (row: number) =>
        block.monthStartMs + valueAt(block, quarterColumn(0), row) * QUARTER_MS;
      const firstAt = quarterStart(first) + valueAt(block, quarterColumn(Q_FIRST), first);
      const lastAt = quarterStart(last) + valueAt(block, quarterColumn(Q_LAST), last);
      if (Number.isNaN(firstActivity) || firstAt < firstActivity) {
        firstActivity = firstAt;
      }
      if (Number.isNaN(lastActivity) || lastAt > lastActivity) {
        lastActivity = lastAt;
      }
      addModels(block, rows);
      addTools(block, rows);
      addBlockMissing(block, first, last);
    },
    addUntimestamped(rollup: SessionUsageRollupData["untimestamped"]): void {
      for (const [index, field] of TOTAL_FIELDS.entries()) {
        extraTotals[index] = extraTotals[index]! + rollup.totals[field];
      }
      if (rollup.totals.missingCostByModel) {
        addMissing((missingState().row ??= {}), Object.entries(rollup.totals.missingCostByModel));
      }
      for (const [index, field] of MESSAGE_FIELDS.entries()) {
        extraMessages[index] = extraMessages[index]! + rollup.messageCounts[field];
      }
      for (const tool of rollup.tools) {
        const id = ids.tool(tool.name);
        reserve();
        touchedTools.add(id);
        tools[id] = tools[id]! + tool.count;
      }
      for (const entry of rollup.models) {
        const id = ids.model(entry.provider ?? null, entry.model ?? null);
        reserve();
        touchedModels.add(id);
        const base = id * MODEL_WIDTH;
        models[base + MODEL_COUNT] = models[base + MODEL_COUNT]! + entry.count;
        for (const [index, field] of TOTAL_FIELDS.entries()) {
          models[base + index] = models[base + index]! + entry.totals[field];
        }
        if (entry.totals.missingCostByModel) {
          addMissingTo(missingState().models, id, Object.entries(entry.totals.missingCostByModel));
        }
      }
    },
    /** Pack the family row and reset the fold for the next family. */
    finishInto(batch: ReturnType<typeof createUsageOverviewBatchBuilder>): void {
      const dayOrder = touchedDays.list.toSorted((a, b) =>
        range.dates[a]! < range.dates[b]! ? -1 : 1,
      );
      const modelOrder = touchedModels.list
        .filter((model) => {
          const base = model * MODEL_WIDTH;
          return (
            models[base + MODEL_COUNT] !== 0 ||
            models[base + TOKENS] !== 0 ||
            models[base + COST] !== 0
          );
        })
        .toSorted((a, b) => {
          const left = a * MODEL_WIDTH;
          const right = b * MODEL_WIDTH;
          return (
            models[right + COST]! - models[left + COST]! ||
            models[right + TOKENS]! - models[left + TOKENS]!
          );
        });
      const dayModelsByDay = new Map<number, number[]>();
      for (const key of touchedDayModels.list) {
        const base = key * DM_WIDTH;
        if (dayModels[base] === 0 && dayModels[base + 1] === 0 && dayModels[base + 2] === 0) {
          continue;
        }
        const day = Math.floor(key / modelCapacity);
        const list = dayModelsByDay.get(day);
        if (list) {
          list.push(key);
        } else {
          dayModelsByDay.set(day, [key]);
        }
      }
      const dayModelOrder = dayOrder.flatMap((day) => {
        const keys = dayModelsByDay.get(day) ?? [];
        return keys.length > 1
          ? keys.toSorted((a, b) => dayModels[b * DM_WIDTH + 1]! - dayModels[a * DM_WIDTH + 1]!)
          : keys;
      });
      const toolOrder = touchedTools.list.toSorted(
        (a, b) => tools[b]! - tools[a]! || ids.tools[a]!.localeCompare(ids.tools[b]!),
      );
      const { values, base, row } = batch.reserveRow({
        days: dayOrder.length,
        models: modelOrder.length,
        tools: toolOrder.length,
        dayModels: dayModelOrder.length,
        hours: quarters > 0,
      });
      // Row totals: days in date order, then untimestamped usage.
      const latency = base + ROW.LATENCY;
      values[latency + 2] = Number.POSITIVE_INFINITY;
      let cursor = base + ROW.HEADER;
      for (const day of dayOrder) {
        const offset = day * DAY_WIDTH;
        values[cursor] = batch.intern(range.dates[day]);
        values.set(days.subarray(offset, offset + DAY_WIDTH), cursor + 1);
        for (let field = 0; field < TOTALS_WIDTH; field += 1) {
          values[base + field] = values[base + field]! + days[offset + field]!;
        }
        for (let field = 0; field < MESSAGE_FIELDS.length; field += 1) {
          values[base + ROW.MESSAGES + field] =
            values[base + ROW.MESSAGES + field]! + days[offset + DAY_MESSAGES + field]!;
        }
        if (days[offset + DAY_LATENCY]! > 0) {
          values[latency] = values[latency]! + days[offset + DAY_LATENCY]!;
          values[latency + 1] = values[latency + 1]! + days[offset + DAY_LATENCY + 1]!;
          values[latency + 2] = Math.min(values[latency + 2]!, days[offset + DAY_LATENCY + 2]!);
          values[latency + 3] = Math.max(values[latency + 3]!, days[offset + DAY_LATENCY + 3]!);
          values[latency + 4] = Math.max(values[latency + 4]!, days[offset + DAY_LATENCY + 4]!);
        }
        cursor += ROW.DAY_WIDTH;
      }
      for (let field = 0; field < TOTALS_WIDTH; field += 1) {
        values[base + field] = values[base + field]! + extraTotals[field]!;
      }
      for (let field = 0; field < MESSAGE_FIELDS.length; field += 1) {
        values[base + ROW.MESSAGES + field] =
          values[base + ROW.MESSAGES + field]! + extraMessages[field]!;
      }
      values[base + ROW.COMPUTED_AT] = computedAt;
      values[base + ROW.STALE_SINCE] = staleSince;
      values[base + ROW.FIRST] = firstActivity;
      values[base + ROW.LAST] = lastActivity;
      values[base + ROW.HOURS] = quarters > 0 ? (precise ? 2 : 1) : 0;
      for (const model of modelOrder) {
        const [provider, name] = ids.models[model]!;
        const offset = model * MODEL_WIDTH;
        values[cursor] = batch.intern(provider);
        values[cursor + 1] = batch.intern(name);
        values[cursor + 2] = models[offset + MODEL_COUNT]!;
        values.set(models.subarray(offset, offset + TOTALS_WIDTH), cursor + 3);
        cursor += ROW.MODEL_WIDTH;
      }
      for (const tool of toolOrder) {
        values[cursor] = batch.intern(ids.tools[tool]);
        values[cursor + 1] = tools[tool]!;
        cursor += ROW.TOOL_WIDTH;
      }
      for (const key of dayModelOrder) {
        const [provider, name] = ids.models[key % modelCapacity]!;
        const offset = key * DM_WIDTH;
        values[cursor] = batch.intern(range.dates[Math.floor(key / modelCapacity)]);
        values[cursor + 1] = batch.intern(provider);
        values[cursor + 2] = batch.intern(name);
        values[cursor + 3] = dayModels[offset]!;
        values[cursor + 4] = dayModels[offset + 1]!;
        values[cursor + 5] = dayModels[offset + 2]!;
        cursor += ROW.DAY_MODEL_WIDTH;
      }
      if (quarters > 0) {
        values.set(hours, cursor);
      }
      if (missing) {
        if (missing.row) {
          batch.addMissing(row, "", missing.row);
        }
        for (const [index, day] of dayOrder.entries()) {
          const counts = missing.days.get(day);
          if (counts) {
            batch.addMissing(row, `d${index}`, counts);
          }
        }
        for (const [index, model] of modelOrder.entries()) {
          const counts = missing.models.get(model);
          if (counts) {
            batch.addMissing(row, `m${index}`, counts);
          }
        }
      }
      // Reset for the next family.
      for (const day of touchedDays.list) {
        days.fill(0, day * DAY_WIDTH, (day + 1) * DAY_WIDTH);
      }
      for (const model of touchedModels.list) {
        models.fill(0, model * MODEL_WIDTH, (model + 1) * MODEL_WIDTH);
      }
      for (const key of touchedDayModels.list) {
        dayModels.fill(0, key * DM_WIDTH, (key + 1) * DM_WIDTH);
      }
      for (const tool of touchedTools.list) {
        tools[tool] = 0;
      }
      touchedDays.clear();
      touchedModels.clear();
      touchedDayModels.clear();
      touchedTools.clear();
      extraTotals.fill(0);
      extraMessages.fill(0);
      hours.fill(0);
      precise = false;
      quarters = 0;
      firstActivity = Number.NaN;
      lastActivity = Number.NaN;
      computedAt = Number.NaN;
      staleSince = Number.NaN;
      missing = undefined;
    },
  };
}
