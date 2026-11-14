import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { readInheritedThrough } from "../config/sessions/transcript-header.js";
import { projectTranscriptNavigationFields } from "../config/sessions/transcript-navigation-fields.js";
import {
  isSessionTranscriptLeafControl,
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
  // A maintenance rewrite re-appends one turn as a copy. Keep the supersession
  // link so billing can recognize the copies of a single turn.
  const supersedes = readNonBlankString(event.supersedesEntryId);
  if (supersedes) {
    record.supersedesEntryId = supersedes;
  }
}

/**
 * Billed rows for one transcript: the active path plus every path that an
 * earlier leaf control selected, minus paths an upstream transcript already
 * counted.
 *
 * Usage reports money that was really spent, so moving the active branch must
 * not remove a completed turn's tokens. Before in-place history cuts, the same
 * total came from the retired copy, which kept counting the path that was
 * active when it was retired.
 */
export function selectBilledTranscriptEvents<T extends Record<string, unknown>>(
  records: readonly T[],
): T[] {
  const tree = scanSessionTranscriptTree(records);
  const selected: T[] = [];
  const seen = new Set<T>();
  const addPath = (leafId: string | null) => {
    for (const node of selectSessionTranscriptTreePathNodes(tree, leafId)) {
      if (!seen.has(node.entry)) {
        seen.add(node.entry);
        selected.push(node.entry);
      }
    }
  };
  // Each leaf control names both branches of one repoint: its target became
  // active, and its raw parent is the tip that was active until then. Both were
  // billed. A sibling that was never active is not reachable this way and stays
  // unbilled, matching the retired-copy accounting this replaced.
  //
  // Order carries no meaning: consumers that need the branch a row belongs to ask
  // `selectActivePathTranscriptEvents`, not the emission sequence.
  addPath(tree.leafId);
  for (const node of tree.nodes) {
    if (!isSessionTranscriptLeafControl(node.entry)) {
      continue;
    }
    addPath(node.id);
    const previousTip = node.entry.parentId;
    if (typeof previousTip === "string" && previousTip) {
      addPath(previousTip);
    }
  }
  // A transcript rewrite re-appends a turn as a copy carrying `supersedesEntryId`
  // and publishes its own leaf control, so both the copy and the original become
  // reachable. They are one spend, not two: drop every selected row that another
  // selected row supersedes, which also collapses a chain of rewrites. A rewind
  // and regenerate bills twice, because the regenerated turn supersedes nothing.
  const superseded = new Set(
    selected.flatMap((record) => readNonBlankString(record.supersedesEntryId) ?? []),
  );
  const billed =
    superseded.size === 0
      ? selected
      : selected.filter((record) => {
          const id = readNonBlankString(record.id);
          return !id || !superseded.has(id);
        });
  // Rows an older appender wrote without an id carry no navigation, so no path
  // reaches them. Without a leaf control the whole transcript is still one
  // branch, and `selectVisibleTranscriptEventEntries` bills it flat; keep that.
  return dropInheritedTranscriptEvents(
    records,
    billed.length === 0 && !tree.hasLeafControl ? [...records] : billed,
  );
}

/**
 * Rows on the canonical active path, in order.
 *
 * Billing decides which rows count; this decides whose turn the next continuation
 * follows. The two differ after a cut: a displaced turn still counts, but the
 * branch a later assistant event continues is the active one.
 */
export function selectActivePathTranscriptEvents<T extends Record<string, unknown>>(
  records: readonly T[],
): T[] {
  const tree = scanSessionTranscriptTree(records);
  return selectSessionTranscriptTreePathNodes(tree, tree.leafId).map((node) => node.entry);
}

/**
 * Fork, branched sessions and subagent parent forks copy history into a new transcript. The
 * header's `inheritedThrough` names copied events whose paths the source transcript (or its own
 * sources) already counts; those paths are dropped here. Copied events off them (an inactive
 * source branch) still count, because no source did. Paths follow the canonical transcript tree,
 * so leaf controls resolve to their targets.
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
