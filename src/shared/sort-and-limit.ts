import { runSynchronousWork, type SynchronousWork } from "./synchronous-work.js";

const TOP_N_LIMIT = 200;
const SORT_RUN_SIZE = 1024;

function* sortEntriesWork<T extends object>(
  entries: T[],
  compare: (a: T, b: T) => number,
  shouldYield?: () => boolean,
): SynchronousWork<T[]> {
  if (!shouldYield || entries.length <= SORT_RUN_SIZE) {
    return entries.toSorted(compare);
  }
  let sorted = entries.slice();
  // Native sorting keeps each run cheap; merging provides checkpoints for wide windows.
  for (let start = 0; start < sorted.length; start += SORT_RUN_SIZE) {
    const run = sorted.slice(start, start + SORT_RUN_SIZE).toSorted(compare);
    for (let index = 0; index < run.length; index++) {
      sorted[start + index] = run[index]!;
    }
    yield;
  }
  let merged = sorted.slice();
  for (let width = SORT_RUN_SIZE; width < sorted.length; width *= 2) {
    for (let start = 0; start < sorted.length; start += width * 2) {
      const middle = Math.min(start + width, sorted.length);
      const end = Math.min(start + width * 2, sorted.length);
      let left = start;
      let right = middle;
      for (let index = start; index < end; index++) {
        if (shouldYield()) {
          yield;
        }
        // Prefer the earlier run for equal entries, preserving the native sort's stability.
        const takeRight =
          left >= middle || (right < end && compare(sorted[left]!, sorted[right]!) > 0);
        merged[index] = takeRight ? sorted[right++]! : sorted[left++]!;
      }
    }
    [sorted, merged] = [merged, sorted];
  }
  return sorted;
}

/** Stable bounded ordering; each caller owns its comparator and validated limit. */
export function sortAndLimitBy<T extends object>(
  entries: T[],
  limit: number | undefined,
  compare: (a: T, b: T) => number,
): T[] {
  return runSynchronousWork(sortAndLimitByWork(entries, limit, compare));
}

/** Checkpoints preserve stable ordering for cooperative callers. */
export function* sortAndLimitByWork<T extends object>(
  entries: T[],
  limit: number | undefined,
  compare: (a: T, b: T) => number,
  shouldYield?: () => boolean,
): SynchronousWork<T[]> {
  if (limit !== undefined && limit <= TOP_N_LIMIT) {
    const selected: T[] = [];
    for (const entry of entries) {
      if (shouldYield?.()) {
        yield;
      }
      const first = selected[0];
      const beforeFirst = first && compare(entry, first) < 0;
      const worst = selected[limit - 1];
      if (!beforeFirst && worst && compare(entry, worst) >= 0) {
        continue;
      }
      let insertAt = 0;
      if (!beforeFirst) {
        let low = 1;
        let high = selected.length;
        // Insert after equal entries to preserve the input order for ties.
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (compare(entry, selected[middle]!) < 0) {
            high = middle;
          } else {
            low = middle + 1;
          }
        }
        insertAt = low < selected.length ? low : -1;
      }
      if (insertAt >= 0) {
        selected.splice(insertAt, 0, entry);
        if (selected.length > limit) {
          selected.pop();
        }
      } else if (selected.length < limit) {
        selected.push(entry);
      }
    }
    return selected;
  }
  const sorted = yield* sortEntriesWork(entries, compare, shouldYield);
  return limit === undefined ? sorted : sorted.slice(0, limit);
}
