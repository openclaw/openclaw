import { projectTranscriptNavigationFields } from "../config/sessions/transcript-navigation-fields.js";

/** Navigation fields plus the header's inherited-history marker, for usage scans. */
export function projectUsageScanFields(
  event: Record<string, unknown>,
  record: Record<string, unknown>,
): void {
  projectTranscriptNavigationFields(event, record);
  if (event.type === "session" && typeof event.inheritedThrough === "string") {
    record.inheritedThrough = event.inheritedThrough;
  }
}

/**
 * Rewind, branch switch, fork, branched sessions and subagent parent forks copy history into a
 * new transcript. The header's `inheritedThrough` names the copied event whose path the source
 * transcript already counts; that path is dropped here. Copied events off that path (an inactive
 * source branch) still count, because the source never did.
 */
export function dropInheritedTranscriptEvents<T extends Record<string, unknown>>(
  records: readonly T[],
  selected: T[],
): T[] {
  const through = records.find((record) => record.type === "session")?.inheritedThrough;
  if (typeof through !== "string") {
    return selected;
  }
  const byId = new Map<string, T>();
  for (const record of records) {
    if (typeof record.id === "string" && !byId.has(record.id)) {
      byId.set(record.id, record);
    }
  }
  const inherited = new Set<T>();
  for (let record = byId.get(through); record && !inherited.has(record);) {
    inherited.add(record);
    record = typeof record.parentId === "string" ? byId.get(record.parentId) : undefined;
  }
  return inherited.size > 0 ? selected.filter((record) => !inherited.has(record)) : selected;
}
