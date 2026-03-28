/**
 * Queue helpers — shared primitives for all bounded, drainable message queues.
 *
 * Design principles (inspired by SQLite's "minimal, correct, fast" philosophy):
 *
 *  1. ZERO external dependencies — pure TypeScript, no imports.
 *  2. In-place front-removal via copyWithin + length truncation.
 *     This avoids Array.shift()'s internal backing-store reallocation in V8,
 *     reducing GC pressure on high-throughput channels (e.g. WhatsApp storms).
 *  3. All mutation is explicit and local — no hidden side-effects.
 *  4. Every exported symbol has a single, well-defined responsibility.
 */

export type QueueDropPolicy = "summarize" | "old" | "new";

export type QueueSummaryState = {
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
};

export type QueueState<T> = QueueSummaryState & {
  items: T[];
  cap: number;
};

export function clearQueueSummaryState(state: QueueSummaryState): void {
  state.droppedCount = 0;
  state.summaryLines = [];
}

export function previewQueueSummaryPrompt(params: {
  state: QueueSummaryState;
  noun: string;
  title?: string;
}): string | undefined {
  return buildQueueSummaryPrompt({
    state: {
      dropPolicy: params.state.dropPolicy,
      droppedCount: params.state.droppedCount,
      summaryLines: [...params.state.summaryLines],
    },
    noun: params.noun,
    title: params.title,
  });
}

export function applyQueueRuntimeSettings<TMode extends string>(params: {
  target: {
    mode: TMode;
    debounceMs: number;
    cap: number;
    dropPolicy: QueueDropPolicy;
  };
  settings: {
    mode: TMode;
    debounceMs?: number;
    cap?: number;
    dropPolicy?: QueueDropPolicy;
  };
}): void {
  params.target.mode = params.settings.mode;
  if (typeof params.settings.debounceMs === "number") {
    params.target.debounceMs = Math.max(0, params.settings.debounceMs);
  }
  if (typeof params.settings.cap === "number" && params.settings.cap > 0) {
    params.target.cap = Math.floor(params.settings.cap);
  }
  if (params.settings.dropPolicy !== undefined) {
    params.target.dropPolicy = params.settings.dropPolicy;
  }
}

export function elideQueueText(text: string, limit = 140): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function buildQueueSummaryLine(text: string, limit = 160): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return elideQueueText(cleaned, limit);
}

export function shouldSkipQueueItem<T>(params: {
  item: T;
  items: T[];
  dedupe?: (item: T, items: T[]) => boolean;
}): boolean {
  if (!params.dedupe) {
    return false;
  }
  return params.dedupe(params.item, params.items);
}

export function applyQueueDropPolicy<T>(params: {
  queue: QueueState<T>;
  summarize: (item: T) => string;
  summaryLimit?: number;
}): boolean {
  const cap = params.queue.cap;
  if (cap <= 0 || params.queue.items.length < cap) {
    return true;
  }
  if (params.queue.dropPolicy === "new") {
    return false;
  }
  // Evict the oldest items to make room for the incoming item.
  const dropCount = params.queue.items.length - cap + 1;

  if (params.queue.dropPolicy === "summarize") {
    // Capture items to summarize before overwriting them in-place.
    for (let i = 0; i < dropCount; i++) {
      params.queue.droppedCount += 1;
      params.queue.summaryLines.push(
        buildQueueSummaryLine(params.summarize(params.queue.items[i])),
      );
    }
    const limit = Math.max(0, params.summaryLimit ?? cap);
    if (params.queue.summaryLines.length > limit) {
      // Keep only the most recent `limit` lines — in-place, no new array.
      const excess = params.queue.summaryLines.length - limit;
      params.queue.summaryLines.copyWithin(0, excess);
      params.queue.summaryLines.length = limit;
    }
  }

  // Remove the first `dropCount` elements in-place.
  // copyWithin + length truncation avoids the allocation that splice(0,n) causes.
  params.queue.items.copyWithin(0, dropCount);
  params.queue.items.length -= dropCount;

  return true;
}

export function waitForQueueDebounce(queue: {
  debounceMs: number;
  lastEnqueuedAt: number;
}): Promise<void> {
  if (process.env.OPENCLAW_TEST_FAST === "1") {
    return Promise.resolve();
  }
  const debounceMs = Math.max(0, queue.debounceMs);
  if (debounceMs <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const check = () => {
      const elapsed = Date.now() - queue.lastEnqueuedAt;
      if (elapsed >= debounceMs) {
        resolve();
        return;
      }
      setTimeout(check, debounceMs - elapsed);
    };
    check();
  });
}

export function beginQueueDrain<T extends { draining: boolean }>(
  map: Map<string, T>,
  key: string,
): T | undefined {
  const queue = map.get(key);
  if (!queue || queue.draining) {
    return undefined;
  }
  queue.draining = true;
  return queue;
}

/**
 * Process the next item in the queue.
 *
 * Uses copyWithin + length truncation for in-place front removal
 * instead of Array.shift() which can trigger V8 backing-store reallocation.
 *
 * Returns true if an item was processed, false if the queue was empty.
 */
export async function drainNextQueueItem<T>(
  items: T[],
  run: (item: T) => Promise<void>,
): Promise<boolean> {
  if (items.length === 0) {
    return false;
  }
  const next = items[0];
  await run(next);
  // In-place removal of the first element.
  items.copyWithin(0, 1);
  items.length -= 1;
  return true;
}

export async function drainCollectItemIfNeeded<T>(params: {
  forceIndividualCollect: boolean;
  isCrossChannel: boolean;
  setForceIndividualCollect?: (next: boolean) => void;
  items: T[];
  run: (item: T) => Promise<void>;
}): Promise<"skipped" | "drained" | "empty"> {
  if (!params.forceIndividualCollect && !params.isCrossChannel) {
    return "skipped";
  }
  if (params.isCrossChannel) {
    params.setForceIndividualCollect?.(true);
  }
  const drained = await drainNextQueueItem(params.items, params.run);
  return drained ? "drained" : "empty";
}

export async function drainCollectQueueStep<T>(params: {
  collectState: { forceIndividualCollect: boolean };
  isCrossChannel: boolean;
  items: T[];
  run: (item: T) => Promise<void>;
}): Promise<"skipped" | "drained" | "empty"> {
  return drainCollectItemIfNeeded({
    forceIndividualCollect: params.collectState.forceIndividualCollect,
    isCrossChannel: params.isCrossChannel,
    setForceIndividualCollect: (next) => {
      params.collectState.forceIndividualCollect = next;
    },
    items: params.items,
    run: params.run,
  });
}

export function buildQueueSummaryPrompt(params: {
  state: QueueSummaryState;
  noun: string;
  title?: string;
}): string | undefined {
  if (params.state.dropPolicy !== "summarize" || params.state.droppedCount <= 0) {
    return undefined;
  }
  const { state, noun } = params;
  const count = state.droppedCount;
  const title =
    params.title ??
    `[Queue overflow] Dropped ${count} ${noun}${count === 1 ? "" : "s"} due to cap.`;
  const lines = [title];
  if (params.state.summaryLines.length > 0) {
    lines.push("Summary:");
    for (const line of params.state.summaryLines) {
      lines.push(`- ${line}`);
    }
  }
  clearQueueSummaryState(params.state);
  return lines.join("\n");
}

export function buildCollectPrompt<T>(params: {
  title: string;
  items: T[];
  summary?: string;
  renderItem: (item: T, index: number) => string;
}): string {
  const blocks: string[] = [params.title];
  if (params.summary) {
    blocks.push(params.summary);
  }
  for (let i = 0; i < params.items.length; i++) {
    blocks.push(params.renderItem(params.items[i], i));
  }
  return blocks.join("\n\n");
}

export function hasCrossChannelItems<T>(
  items: T[],
  resolveKey: (item: T) => { key?: string; cross?: boolean },
): boolean {
  const keys = new Set<string>();
  let hasUnkeyed = false;

  for (const item of items) {
    const resolved = resolveKey(item);
    if (resolved.cross) {
      return true;
    }
    if (!resolved.key) {
      hasUnkeyed = true;
      continue;
    }
    keys.add(resolved.key);
  }

  if (keys.size === 0) {
    return false;
  }
  if (hasUnkeyed) {
    return true;
  }
  return keys.size > 1;
}
