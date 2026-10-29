import { readInheritedThrough } from "../config/sessions/transcript-header.js";
import { projectTranscriptNavigationFields } from "../config/sessions/transcript-navigation-fields.js";

/** Navigation fields plus the header's inherited-history marker, for usage scans. */
export function projectUsageScanFields(
  event: Record<string, unknown>,
  record: Record<string, unknown>,
): void {
  projectTranscriptNavigationFields(event, record);
  if (event.type === "session" && event.inheritedThrough !== undefined) {
    record.inheritedThrough = readInheritedThrough(event);
  }
}

/**
 * Rewind, branch switch, fork, branched sessions and subagent parent forks copy history into a
 * new transcript. The header's `inheritedThrough` names copied events whose paths the source
 * transcript (or its own sources) already counts; those paths are dropped here. Copied events off
 * them (an inactive source branch) still count, because no source did.
 */
export function dropInheritedTranscriptEvents<T extends Record<string, unknown>>(
  records: readonly T[],
  selected: T[],
): T[] {
  const through = readInheritedThrough(records.find((record) => record.type === "session"));
  if (through.length === 0) {
    return selected;
  }
  const byId = new Map<string, T>();
  for (const record of records) {
    if (typeof record.id === "string" && !byId.has(record.id)) {
      byId.set(record.id, record);
    }
  }
  const inherited = new Set<T>();
  for (const id of through) {
    for (let record = byId.get(id); record && !inherited.has(record);) {
      inherited.add(record);
      record = typeof record.parentId === "string" ? byId.get(record.parentId) : undefined;
    }
  }
  return inherited.size > 0 ? selected.filter((record) => !inherited.has(record)) : selected;
}
