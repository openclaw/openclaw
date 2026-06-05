// Snapshot hydration helpers merge saved runtime skill snapshots into live state.
type SnapshotWithRuntimeSkills = {
  metaSkillCatalog?: unknown;
  resolvedSkills?: unknown;
};

type SnapshotRebuild<T extends SnapshotWithRuntimeSkills> = {
  metaSkillCatalog?: T["metaSkillCatalog"];
  resolvedSkills?: T["resolvedSkills"];
};

// These fields are runtime-only: session persistence keeps the lightweight
// catalog/prompt, while consumers that need concrete SKILL.md paths or derived
// meta plans hydrate them from a fresh workspace scan.
export function hydrateResolvedSkills<T extends SnapshotWithRuntimeSkills>(
  snapshot: T,
  rebuild: () => SnapshotRebuild<T>,
): T {
  if (snapshot.resolvedSkills !== undefined && snapshot.metaSkillCatalog !== undefined) {
    return snapshot;
  }
  const rebuilt = rebuild();
  return {
    ...snapshot,
    metaSkillCatalog: rebuilt.metaSkillCatalog,
    resolvedSkills: rebuilt.resolvedSkills,
  };
}

export async function hydrateResolvedSkillsAsync<T extends SnapshotWithRuntimeSkills>(
  snapshot: T,
  rebuild: () => Promise<SnapshotRebuild<T>>,
): Promise<T> {
  if (snapshot.resolvedSkills !== undefined && snapshot.metaSkillCatalog !== undefined) {
    return snapshot;
  }
  const rebuilt = await rebuild();
  return {
    ...snapshot,
    metaSkillCatalog: rebuilt.metaSkillCatalog,
    resolvedSkills: rebuilt.resolvedSkills,
  };
}
