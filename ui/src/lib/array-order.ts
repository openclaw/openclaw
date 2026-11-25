export type ArrayDropPosition = "before" | "after";

/** Move one entry into the target slot, or explicitly before/after the target. */
export function moveArrayEntry<T>(
  order: readonly T[],
  source: T,
  target: T,
  position?: ArrayDropPosition,
): T[] {
  const ordered = [...order];
  const sourceIndex = ordered.indexOf(source);
  const targetIndex = ordered.indexOf(target);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return ordered;
  }
  ordered.splice(sourceIndex, 1);
  const insertionIndex = position
    ? ordered.indexOf(target) + (position === "after" ? 1 : 0)
    : targetIndex;
  ordered.splice(insertionIndex, 0, source);
  return ordered;
}
