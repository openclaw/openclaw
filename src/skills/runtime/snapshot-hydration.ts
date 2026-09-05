// Snapshot hydration helpers merge saved runtime skill snapshots into live state.
type SnapshotWithRuntimeSkills = {
  resolvedSkills?: unknown;
  resolvedSkillCommands?: unknown;
};

type SnapshotRebuild<T extends SnapshotWithRuntimeSkills> = {
  resolvedSkills?: T["resolvedSkills"];
  resolvedSkillCommands?: T["resolvedSkillCommands"];
};

// Full skill objects and command identities are runtime-only: session persistence
// keeps the lightweight catalog/prompt, then a fresh workspace scan hydrates both.
export function hydrateRuntimeSkillFields<T extends SnapshotWithRuntimeSkills>(
  snapshot: T,
  rebuild: () => SnapshotRebuild<T>,
): T {
  const needsResolvedSkills = snapshot.resolvedSkills === undefined;
  const needsResolvedSkillCommands = snapshot.resolvedSkillCommands === undefined;
  if (!needsResolvedSkills && !needsResolvedSkillCommands) {
    return snapshot;
  }
  const rebuilt = rebuild();
  return {
    ...snapshot,
    ...(needsResolvedSkills ? { resolvedSkills: rebuilt.resolvedSkills } : {}),
    ...(needsResolvedSkillCommands ? { resolvedSkillCommands: rebuilt.resolvedSkillCommands } : {}),
  };
}
