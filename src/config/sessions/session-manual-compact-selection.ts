import { safeParseJsonRecord } from "@openclaw/normalization-core";
import type { SessionTranscriptManualTrimResult } from "./session-accessor.types.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

export function selectManualCompactTranscriptLines(
  lines: readonly string[],
  requestedMaxLines: number,
): { lines: readonly string[]; result: SessionTranscriptManualTrimResult } {
  if (lines.length === 0) {
    return { lines, result: { compacted: false, reason: "no transcript" } };
  }
  const maxLines = Math.max(1, Math.floor(requestedMaxLines));
  if (lines.length <= maxLines) {
    return { lines, result: { compacted: false, kept: lines.length } };
  }
  const maxTailLines = Math.max(0, maxLines - 1);
  const retained = normalizeManualCompactTranscriptLines(
    lines[0],
    maxTailLines > 0 ? lines.slice(1).slice(-maxTailLines) : [],
  );
  return retained
    ? { lines: retained, result: { compacted: true, kept: retained.length } }
    : { lines, result: { compacted: false, kept: 0 } };
}

function normalizeManualCompactTranscriptLines(
  headerLine: string | undefined,
  tailLines: readonly string[],
): string[] | null {
  if (!headerLine) {
    return null;
  }
  const header = safeParseJsonRecord(headerLine);
  if (header?.type !== "session" || typeof header.id !== "string") {
    return null;
  }

  const records = tailLines
    .map(safeParseJsonRecord)
    .filter((record): record is Record<string, unknown> => record !== undefined);
  const retainedIds = new Set<string>();
  const transparentParents = new Map<string, string | null>();
  const normalizedRecords: Record<string, unknown>[] = [];
  for (const record of records) {
    let parentId = record.parentId;
    const seenTransparentParents = new Set<string>();
    while (
      typeof parentId === "string" &&
      transparentParents.has(parentId) &&
      !seenTransparentParents.has(parentId)
    ) {
      seenTransparentParents.add(parentId);
      parentId = transparentParents.get(parentId) ?? null;
    }
    let next =
      typeof parentId === "string" && !retainedIds.has(parentId)
        ? { ...record, parentId: null }
        : parentId !== record.parentId
          ? { ...record, parentId }
          : record;
    if (next.type === "leaf") {
      const targetId = next.targetId;
      const validTargetId =
        targetId === null || (typeof targetId === "string" && targetId.trim().length > 0);
      if (!validTargetId && typeof next.id === "string") {
        transparentParents.set(
          next.id,
          next.parentId === null || typeof next.parentId === "string" ? next.parentId : null,
        );
      }
      if (typeof targetId === "string" && targetId.trim() && !retainedIds.has(targetId)) {
        // The selected branch fell outside the retained window. Select an
        // empty root instead of accidentally activating abandoned or side rows.
        next = { ...next, targetId: null, appendParentId: null };
      } else if (
        validTargetId &&
        typeof next.appendParentId === "string" &&
        !retainedIds.has(next.appendParentId)
      ) {
        next = { ...next, appendParentId: targetId };
      }
    }
    if ((next.type === "compaction" || next.type === "reset") && typeof next.id === "string") {
      const firstKeptEntryId = next.firstKeptEntryId;
      if (typeof firstKeptEntryId === "string" && firstKeptEntryId !== next.id) {
        const tree = scanSessionTranscriptTree([...normalizedRecords, next]);
        const branchPath = selectSessionTranscriptTreePathNodes(tree, next.id);
        if (!branchPath.some((node) => node.id === firstKeptEntryId)) {
          // Replay starts at the earliest retained entry on this compaction's
          // normalized branch, never at an abandoned row earlier in file order.
          next = { ...next, firstKeptEntryId: branchPath[0]?.id ?? next.id };
        }
      }
    }
    normalizedRecords.push(next);
    if (typeof next.id === "string" && next.id.trim()) {
      retainedIds.add(next.id);
    }
  }
  return [JSON.stringify(header), ...normalizedRecords.map((record) => JSON.stringify(record))];
}
