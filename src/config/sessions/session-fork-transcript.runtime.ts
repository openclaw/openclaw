// Parent-fork transcript source reading and branch-entry construction.
// The session accessor composes these helpers with createForkedSessionTranscript
// so parent forks stay one storage-owned operation (#88838).
import crypto from "node:crypto";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  migrateSessionEntries,
  parseSessionEntries,
  type SessionEntry as AgentSessionEntry,
  type SessionHeader,
} from "../../agents/sessions/session-manager.js";
import { readRegularFile } from "../../infra/fs-safe.js";
import {
  isSessionTranscriptLeafControl,
  mergeSessionTranscriptVisiblePathWithOpaqueAppendPath,
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

/** Active-branch snapshot of a parent transcript selected for forking. */
export type ForkSourceTranscript = {
  cwd: string;
  sessionDir: string;
  leafId: string | null;
  appendParentId: string | null;
  appendMode?: "side";
  preserveLeafControl: boolean;
  branchEntries: unknown[];
  labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }>;
};

function generateEntryId(existingIds: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = crypto.randomUUID().slice(0, 8);
    if (!existingIds.has(id)) {
      existingIds.add(id);
      return id;
    }
  }
  const id = crypto.randomUUID();
  existingIds.add(id);
  return id;
}

/** True when the selected branch carries at least one assistant message. */
export function forkSourceHasAssistantEntry(entries: unknown[]): boolean {
  return entries.some(
    (entry) =>
      isRecord(entry) &&
      entry.type === "message" &&
      isRecord(entry.message) &&
      entry.message.role === "assistant",
  );
}

function collectBranchLabels(params: {
  allEntries: unknown[];
  pathEntryIds: Set<string>;
}): Array<{ targetId: string; label: string; timestamp: string }> {
  const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
  for (const entry of params.allEntries) {
    if (!isRecord(entry)) {
      continue;
    }
    if (
      entry.type === "label" &&
      typeof entry.label === "string" &&
      typeof entry.targetId === "string" &&
      typeof entry.id === "string" &&
      !params.pathEntryIds.has(entry.id) &&
      params.pathEntryIds.has(entry.targetId) &&
      typeof entry.timestamp === "string"
    ) {
      labelsToWrite.push({
        targetId: entry.targetId,
        label: entry.label,
        timestamp: entry.timestamp,
      });
    }
  }
  return labelsToWrite;
}

/** Reads the parent transcript and selects the active branch to copy. */
export async function readForkSourceTranscript(
  parentSessionFile: string,
): Promise<ForkSourceTranscript | null> {
  const raw = (await readRegularFile({ filePath: parentSessionFile })).buffer.toString("utf-8");
  const fileEntries = parseSessionEntries(raw);
  migrateSessionEntries(fileEntries);
  const header =
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  const entries = fileEntries.filter((entry) => entry.type !== "session");
  const tree = scanSessionTranscriptTree(entries);
  const leafId = tree.leafId;
  const appendParentId = tree.appendParentId;
  const visiblePath = selectSessionTranscriptTreePathNodes(tree, leafId);
  const appendPath = selectSessionTranscriptTreePathNodes(tree, appendParentId);
  const mergedPath = mergeSessionTranscriptVisiblePathWithOpaqueAppendPath({
    visiblePath,
    appendPath,
    appendParentId,
  });
  const branchEntries = mergedPath.nodes.flatMap((node) => {
    if (!isRecord(node.entry)) {
      return [];
    }
    const parentId = node.selectedParentId;
    return [node.entry.parentId === parentId ? node.entry : { ...node.entry, parentId }];
  });
  const pathEntryIds = new Set(
    branchEntries.flatMap((entry) =>
      isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [],
    ),
  );
  const lastLeafUpdateNode = tree.nodes.findLast((node) => node.leafId !== undefined);
  const lastLeafUpdateEntry = lastLeafUpdateNode?.entry;
  return {
    cwd: header?.cwd ?? process.cwd(),
    sessionDir: path.dirname(parentSessionFile),
    leafId,
    appendParentId: mergedPath.appendParentId,
    ...(lastLeafUpdateNode?.appendMode ? { appendMode: lastLeafUpdateNode.appendMode } : {}),
    preserveLeafControl: isSessionTranscriptLeafControl(lastLeafUpdateEntry),
    branchEntries,
    labelsToWrite: collectBranchLabels({ allEntries: entries, pathEntryIds }),
  };
}

function buildBranchLabelEntries(params: {
  labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }>;
  pathEntryIds: Set<string>;
  lastEntryId: string | null;
}): AgentSessionEntry[] {
  let parentId = params.lastEntryId;
  const labelEntries: AgentSessionEntry[] = [];
  for (const { targetId, label, timestamp } of params.labelsToWrite) {
    const labelEntry = {
      type: "label",
      id: generateEntryId(params.pathEntryIds),
      parentId,
      timestamp,
      targetId,
      label,
    } satisfies AgentSessionEntry;
    params.pathEntryIds.add(labelEntry.id);
    labelEntries.push(labelEntry);
    parentId = labelEntry.id;
  }
  return labelEntries;
}

/** Builds the copied branch, re-targeted labels, and optional leaf control for a fork. */
export function buildForkedBranchEntries(params: {
  source: ForkSourceTranscript;
  /** Fork header timestamp; the leaf control shares it so the copied branch reopens on the parent's active leaf. */
  timestamp: string;
}): unknown[] {
  const pathEntries = params.source.branchEntries;
  const pathEntryIds = new Set(
    pathEntries.flatMap((entry) =>
      isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [],
    ),
  );
  const lastPathEntry = pathEntries.at(-1);
  const lastPathEntryId =
    isRecord(lastPathEntry) && typeof lastPathEntry.id === "string" ? lastPathEntry.id : null;
  const labelEntries = buildBranchLabelEntries({
    labelsToWrite: params.source.labelsToWrite,
    pathEntryIds,
    lastEntryId: lastPathEntryId,
  });
  const leafEntry = params.source.preserveLeafControl
    ? {
        type: "leaf",
        id: generateEntryId(pathEntryIds),
        parentId: labelEntries.at(-1)?.id ?? lastPathEntryId,
        timestamp: params.timestamp,
        targetId: params.source.leafId,
        appendParentId: params.source.appendParentId,
        ...(params.source.appendMode ? { appendMode: params.source.appendMode } : {}),
      }
    : null;
  return [...pathEntries, ...labelEntries, ...(leafEntry ? [leafEntry] : [])];
}
