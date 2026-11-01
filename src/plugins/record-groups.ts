import type { PluginOrigin } from "./plugin-origin.types.js";

// Explicit selection favors operator sources; provider setup prefers bundled metadata.
export const PLUGIN_ORIGIN_PRIORITIES: Readonly<
  Record<PluginOrigin, { explicit: number; provider: number }>
> = {
  config: { explicit: 0, provider: 0 },
  workspace: { explicit: 1, provider: 3 },
  global: { explicit: 2, provider: 2 },
  bundled: { explicit: 3, provider: 1 },
};

export function groupPluginRecords<T, K>(
  records: Iterable<T>,
  keyOf: (record: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const record of records) {
    const key = keyOf(record);
    const group = groups.get(key);
    if (group) {
      group.push(record);
    } else {
      groups.set(key, [record]);
    }
  }
  return groups;
}
