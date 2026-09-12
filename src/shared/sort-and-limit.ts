const TOP_N_LIMIT = 200;

/** Stable bounded ordering; each caller owns its comparator and validated limit. */
export function sortAndLimitBy<T extends object>(
  entries: T[],
  limit: number | undefined,
  compare: (a: T, b: T) => number,
): T[] {
  if (limit !== undefined && limit <= TOP_N_LIMIT) {
    const selected: T[] = [];
    for (const entry of entries) {
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
  const sorted = entries.toSorted(compare);
  return limit === undefined ? sorted : sorted.slice(0, limit);
}
