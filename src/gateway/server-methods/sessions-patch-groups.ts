import type { PreparedPatchTarget } from "./sessions-patch-types.js";

/** Tree archival commits descendants before ancestors, including across physical stores. */
export async function runSessionPatchGroups(
  targets: readonly PreparedPatchTarget[],
  apply: (group: PreparedPatchTarget[]) => Promise<void>,
): Promise<void> {
  const ready = targets.filter(
    (target) => target.fullPatch.archived !== true || target.archivePreparation !== undefined,
  );
  if (
    ready.some(
      (target) =>
        target.fullPatch.archived === true &&
        target.fullPatch.expectedSidebarAncestors !== undefined,
    )
  ) {
    // Store grouping can reorder a mixed-agent tree even when the caller sends deepest-first.
    // Settle each descendant's commit before an ancestor changes the retained guard facts.
    for (const target of ready.toSorted(
      (a, b) =>
        (b.fullPatch.expectedSidebarAncestors?.length ?? 0) -
        (a.fullPatch.expectedSidebarAncestors?.length ?? 0),
    )) {
      await apply([target]);
    }
    return;
  }
  const groups = new Map<string, PreparedPatchTarget[]>();
  for (const target of ready) {
    const key = target.storePath + "\0" + target.targetAgentId;
    const group = groups.get(key) ?? [];
    group.push(target);
    groups.set(key, group);
  }
  await Promise.all([...groups.values()].map(apply));
}
