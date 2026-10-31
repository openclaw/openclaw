const TOP_N_LIMIT = 200;

/** Stable bounded ordering; each caller owns its comparator and validated limit. */
export function sortAndLimitBy<T>(
  entries: T[],
  limit: number | undefined,
  compare: (a: T, b: T) => number,
): T[] {
  if (limit !== undefined && limit <= TOP_N_LIMIT) {
    const selected: T[] = [];
    let preferFirst = false;
    let index = 0;
    while (index < entries.length) {
      const entry = entries[index++]!;
      const first = selected[0];
      const beforeFirst: boolean | undefined =
        preferFirst && first !== undefined ? compare(entry, first) < 0 : undefined;
      const worst = selected[limit - 1];
      if (!beforeFirst && worst !== undefined && compare(entry, worst) >= 0) {
        preferFirst = false;
        continue;
      }
      // Follow ascending/descending runs without comparing both endpoints for every row.
      preferFirst = beforeFirst ?? (first !== undefined && compare(entry, first) < 0);
      let insertAt = 0;
      if (!preferFirst) {
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
