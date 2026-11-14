import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { readInheritedThrough } from "../config/sessions/transcript-header.js";
import { projectTranscriptNavigationFields } from "../config/sessions/transcript-navigation-fields.js";
import {
  isSessionTranscriptLeafControl,
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "../config/sessions/transcript-tree.js";
import type { ParsedTranscriptEntry, UsageRollupTiming } from "./session-cost-usage.types.js";

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
 * Canonical billing and timing for one transcript, from the navigation owner.
 *
 * `billed` is the active path plus both branches of every leaf control, minus
 * paths an upstream transcript already counted. Usage reports money that was
 * really spent, so moving the active branch must not remove a completed turn's
 * tokens; before in-place cuts the same total came from the retired copy, which
 * kept counting the path that was active when it was retired.
 *
 * `userTurnOf` names each billed row's own nearest user ancestor on its canonical
 * path, so a reply's latency never depends on billing dedup or emission order.
 * `activeUserTurn` is the canonical active path's latest user turn: the cursor the
 * next append-only scan continues from.
 *
 * `navigated` is false for a transcript without leaf controls, which
 * `selectSessionTranscriptLeafControlledPath` leaves entirely active; those rows
 * keep the flat, file-order timing their legacy appender produced.
 */
export type BilledTranscriptPaths<T> = {
  billed: T[];
  userTurnOf: ReadonlyMap<T, T>;
  activeUserTurn?: T;
  navigated: boolean;
};

export function selectBilledTranscriptPaths<T extends Record<string, unknown>>(
  records: readonly T[],
  isUserTurn: (record: T) => boolean,
): BilledTranscriptPaths<T> {
  const tree = scanSessionTranscriptTree(records);
  const selected: T[] = [];
  const seen = new Set<T>();
  const userTurnOf = new Map<T, T>();
  const addPath = (leafId: string | null | undefined) => {
    if (leafId === undefined) {
      return;
    }
    let userTurn: T | undefined;
    for (const node of selectSessionTranscriptTreePathNodes(tree, leafId)) {
      if (!seen.has(node.entry)) {
        seen.add(node.entry);
        selected.push(node.entry);
      }
      // Ancestry is unique per row, so one visit settles its user turn.
      if (userTurn !== undefined && !userTurnOf.has(node.entry)) {
        userTurnOf.set(node.entry, userTurn);
      }
      if (isUserTurn(node.entry)) {
        userTurn = node.entry;
      }
    }
    return userTurn;
  };
  // Each leaf control names both branches of one repoint: the leaf it selected,
  // and the canonical leaf it displaced, which the navigation scan resolved in
  // file order. Both were billed. A sibling that was never active is not
  // reachable this way and stays unbilled, matching the retired-copy accounting
  // this replaced. Emission order carries no meaning.
  const activeUserTurn = addPath(tree.leafId);
  for (const node of tree.nodes) {
    if (!isSessionTranscriptLeafControl(node.entry) || node.leafId === undefined) {
      // An invalid control changed no navigation, so it displaced no branch.
      continue;
    }
    addPath(node.leafId);
    addPath(node.displacedLeafId);
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
  const selection = dropInheritedTranscriptEvents(
    records,
    billed.length === 0 && !tree.hasLeafControl ? [...records] : billed,
  );
  // A transcript the visible-event owner leaves entirely active has no branch to
  // resolve timing against, so it keeps the flat, file-order timing its legacy
  // appender produced: the same fallback that owner applies.
  return tree.hasLeafControl
    ? { billed: selection, userTurnOf, activeUserTurn, navigated: true }
    : { billed: selection, userTurnOf: new Map(), navigated: false };
}

/** Billed rows alone, for diagnostics that report counted history. */
export function selectBilledTranscriptEvents<T extends Record<string, unknown>>(
  records: readonly T[],
): T[] {
  return selectBilledTranscriptPaths(records, () => false).billed;
}

/** The billed usage rows of one full scan, with the canonical timing they need. */
export function selectBilledUsageEntries<
  T extends Record<string, unknown> & { usageEntry: ParsedTranscriptEntry | null },
>(records: readonly T[]): { entries: ParsedTranscriptEntry[]; timing?: UsageRollupTiming } {
  const paths = selectBilledTranscriptPaths(
    records,
    (record) => record.usageEntry?.role === "user",
  );
  const entries = paths.billed.flatMap((record) => (record.usageEntry ? [record.usageEntry] : []));
  if (!paths.navigated) {
    return { entries };
  }
  const userTimestamps = new Map<ParsedTranscriptEntry, number>();
  for (const record of paths.billed) {
    const userTurn = paths.userTurnOf.get(record)?.usageEntry?.timestamp?.getTime();
    if (record.usageEntry && userTurn !== undefined) {
      userTimestamps.set(record.usageEntry, userTurn);
    }
  }
  const activeUserTimestamp = paths.activeUserTurn?.usageEntry?.timestamp?.getTime();
  return {
    entries,
    timing: {
      userTimestamps,
      ...(activeUserTimestamp !== undefined ? { activeUserTimestamp } : {}),
    },
  };
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
