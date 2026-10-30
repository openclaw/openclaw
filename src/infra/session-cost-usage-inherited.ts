import { readInheritedThrough } from "../config/sessions/transcript-header.js";
import { projectTranscriptNavigationFields } from "../config/sessions/transcript-navigation-fields.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "../config/sessions/transcript-tree.js";

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
 * them (an inactive source branch) still count, because no source did. Paths follow the canonical
 * transcript tree, so leaf controls resolve to their targets.
 */
export function dropInheritedTranscriptEvents<T extends Record<string, unknown>>(
  records: readonly T[],
  selected: T[],
): T[] {
  const through = readInheritedThrough(records.find((record) => record.type === "session"));
  if (through.length === 0) {
    return selected;
  }
  const tree = scanSessionTranscriptTree(records);
  const inherited = new Set<T>();
  for (const id of through) {
    for (const node of selectSessionTranscriptTreePathNodes(tree, id)) {
      inherited.add(node.entry);
    }
  }
  return inherited.size > 0 ? selected.filter((record) => !inherited.has(record)) : selected;
}
