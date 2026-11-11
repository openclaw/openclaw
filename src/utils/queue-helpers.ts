import { expectDefined } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { QueueDropPolicy } from "../config/types.queue.js";
import { isFastTestRuntimeEnv } from "../infra/env.js";
import { sleep } from "./sleep.js";

type QueueSummaryState = {
  droppedCount: number;
  summaryLines: string[];
};

/** Build a summary prompt preview without mutating the source queue state. */
export function previewQueueSummaryPrompt(state: QueueSummaryState): string | undefined {
  if (state.droppedCount <= 0) {
    return undefined;
  }
  const lines = [
    `[Queue overflow] Dropped ${state.droppedCount} message${state.droppedCount === 1 ? "" : "s"} due to cap.`,
  ];
  if (state.summaryLines.length > 0) {
    lines.push("Summary:");
    for (const line of state.summaryLines) {
      lines.push(`- ${line}`);
    }
  }
  return lines.join("\n");
}

/** Count identities that are still pending in the queue, excluding active deliveries. */
export function countPendingQueueItems<T>(items: readonly T[], inFlight?: ReadonlySet<T>): number {
  if (!inFlight || inFlight.size === 0) {
    return items.length;
  }
  return items.reduce((count, item) => count + (inFlight.has(item) ? 0 : 1), 0);
}

/** Apply overflow policy before enqueueing another item. */
export function applyQueueDropPolicy<T>(params: {
  queue: QueueSummaryState & {
    items: T[];
    cap: number;
    dropPolicy: QueueDropPolicy;
  };
  summarize: (item: T) => string;
  onDrop?: (items: T[]) => void;
  onSummaryElide?: (lines: string[]) => void;
  inFlight?: ReadonlySet<T>;
  isProtected?: (item: T) => boolean;
}): boolean {
  const cap = params.queue.cap;
  const pendingCount = countPendingQueueItems(params.queue.items, params.inFlight);
  if (cap <= 0 || pendingCount < cap) {
    return true;
  }
  if (params.queue.dropPolicy === "new") {
    return false;
  }
  const dropCount = pendingCount - cap + 1;
  // Collect victim indices first. In-flight identities stay until delivery
  // succeeds; protected priority runs (e.g. stranded-reply retries) also stay.
  // Only mutate the queue when enough victims exist so a partial drop cannot
  // admit overflow when the queue is full of in-flight/protected work.
  const victimIndices: number[] = [];
  for (const [index, item] of params.queue.items.entries()) {
    if (params.inFlight?.has(item) || params.isProtected?.(item) === true) {
      continue;
    }
    victimIndices.push(index);
    if (victimIndices.length === dropCount) {
      break;
    }
  }
  if (victimIndices.length < dropCount) {
    return false;
  }
  const dropped: T[] = [];
  for (let i = victimIndices.length - 1; i >= 0; i -= 1) {
    dropped.unshift(
      ...params.queue.items.splice(expectDefined(victimIndices[i], "victim indices entry at i"), 1),
    );
  }
  params.onDrop?.(dropped);
  if (params.queue.dropPolicy === "summarize") {
    for (const item of dropped) {
      params.queue.droppedCount += 1;
      const cleaned = params.summarize(item).replace(/\s+/g, " ").trim();
      params.queue.summaryLines.push(
        cleaned.length <= 160 ? cleaned : `${truncateUtf16Safe(cleaned, 159).trimEnd()}…`,
      );
    }
    // Summary memory is bounded independently from the item cap to avoid prompt blowups.
    const summaryLines = params.queue.summaryLines;
    if (summaryLines.length > cap) {
      // Round the cutoff first; subtraction can erase a fraction just below an integer.
      const elidedLines = summaryLines.splice(0, summaryLines.length - Math.floor(cap));
      params.onSummaryElide?.(elidedLines);
    }
  }
  return true;
}

export async function waitForQueueDebounce(
  queue: {
    debounceMs: number;
    lastEnqueuedAt: number;
  },
  abortSignal?: AbortSignal,
): Promise<void> {
  if (isFastTestRuntimeEnv()) {
    // Tests use this escape hatch so debounce logic does not slow deterministic queue specs.
    return;
  }
  const debounceMs = Math.max(0, queue.debounceMs);
  if (debounceMs <= 0 || abortSignal?.aborted) {
    return;
  }
  let observedEnqueuedAt: number | undefined;
  let observedAtMs = 0;
  while (true) {
    const nowMs = performance.now();
    if (queue.lastEnqueuedAt !== observedEnqueuedAt) {
      observedEnqueuedAt = queue.lastEnqueuedAt;
      observedAtMs = nowMs;
    }
    // Wall time counts quiet time before this wait; elapsed time keeps a
    // backward wall-clock step from extending the window until wall time catches up.
    const since = Math.max(Date.now() - queue.lastEnqueuedAt, nowMs - observedAtMs);
    if (abortSignal?.aborted || since >= debounceMs) {
      return;
    }
    await sleep(debounceMs - since, abortSignal).catch(() => undefined);
  }
}

/** Render a collect prompt from queued items. */
export function buildCollectPrompt<T>(params: {
  title: string;
  items: T[];
  renderItem: (item: T, index: number) => string;
}): string {
  const blocks: string[] = [params.title];
  params.items.forEach((item, idx) => {
    blocks.push(params.renderItem(item, idx));
  });
  return blocks.join("\n\n");
}
