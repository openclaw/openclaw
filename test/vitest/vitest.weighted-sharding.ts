import type { TestSpecification } from "vitest/node";

export function selectWeightedShard(
  files: TestSpecification[],
  shard: { count: number; index: number },
  estimateWeight: (file: TestSpecification) => number,
  affinityKey?: (file: TestSpecification) => string | undefined,
): TestSpecification[] {
  const buckets = Array.from({ length: shard.count }, () => ({
    weight: 0,
    files: [] as TestSpecification[],
  }));
  // Discovery is the sole membership authority; stale measurements may affect
  // balance but can never add, omit, or duplicate a discovered specification.
  const weightedGroups: Array<{ weight: number; files: TestSpecification[] }> = [];
  const affinities = new Map<string, (typeof weightedGroups)[number]>();
  for (const file of files) {
    const key = affinityKey?.(file);
    let group = key === undefined ? undefined : affinities.get(key);
    if (!group) {
      group = { weight: 0, files: [] };
      weightedGroups.push(group);
      if (key !== undefined) {
        affinities.set(key, group);
      }
    }
    group.weight += estimateWeight(file);
    group.files.push(file);
  }
  for (const group of weightedGroups) {
    group.files.sort((left, right) => left.moduleId.localeCompare(right.moduleId));
  }
  weightedGroups.sort(
    (left, right) =>
      right.weight - left.weight || left.files[0]!.moduleId.localeCompare(right.files[0]!.moduleId),
  );
  for (const { weight, files: groupFiles } of weightedGroups) {
    const bucket = buckets.reduce((lightest, candidate) =>
      candidate.weight < lightest.weight ? candidate : lightest,
    );
    bucket.weight += weight;
    bucket.files.push(...groupFiles);
  }
  return buckets[shard.index - 1]!.files;
}
