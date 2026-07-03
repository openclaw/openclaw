/** Runtime implementation for forking sessions from parent transcripts. */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  migrateSessionEntries,
  parseSessionEntries,
  type SessionEntry as AgentSessionEntry,
  type SessionHeader,
} from "../../agents/sessions/session-manager.js";
import { derivePromptTokens } from "../../agents/usage.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import {
  isSessionTranscriptLeafControl,
  mergeSessionTranscriptVisiblePathWithOpaqueAppendPath,
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "../../config/sessions/transcript-tree.js";
import {
  resolveFreshSessionTotalTokens,
  type SessionEntry as StoreSessionEntry,
} from "../../config/sessions/types.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import { readLatestRecentSessionUsageFromTranscriptAsync } from "../../gateway/session-utils.fs.js";
import { readRegularFile } from "../../infra/fs-safe.js";

type ForkSourceTranscript = {
  cwd: string;
  sessionDir: string;
  leafId: string | null;
  appendParentId: string | null;
  appendMode?: "side";
  preserveLeafControl: boolean;
  branchEntries: unknown[];
  labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }>;
};

const FALLBACK_TRANSCRIPT_BYTES_PER_TOKEN = 4;

function resolvePositiveTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function maxPositiveTokenCount(...values: Array<number | undefined>): number | undefined {
  let max: number | undefined;
  for (const value of values) {
    const normalized = resolvePositiveTokenCount(value);
    if (typeof normalized === "number" && (max === undefined || normalized > max)) {
      max = normalized;
    }
  }
  return max;
}

async function estimateParentTranscriptTokensFromBytes(params: {
  parentEntry: StoreSessionEntry;
  storePath: string;
}): Promise<number | undefined> {
  try {
    const filePath = resolveSessionFilePath(
      params.parentEntry.sessionId,
      params.parentEntry,
      resolveSessionFilePathOptions({ storePath: params.storePath }),
    );
    const stat = await fs.stat(filePath);
    return resolvePositiveTokenCount(Math.ceil(stat.size / FALLBACK_TRANSCRIPT_BYTES_PER_TOKEN));
  } catch {
    return undefined;
  }
}

/** Resolves the best available token count for a parent session before forking. */
export async function resolveParentForkTokenCountRuntime(params: {
  parentEntry: StoreSessionEntry;
  storePath: string;
}): Promise<number | undefined> {
  const freshPersistedTokens = resolveFreshSessionTotalTokens(params.parentEntry);
  if (typeof freshPersistedTokens === "number") {
    return freshPersistedTokens;
  }

  const cachedTokens = resolvePositiveTokenCount(params.parentEntry.totalTokens);
  const byteEstimateTokens = await estimateParentTranscriptTokensFromBytes(params);
  try {
    const usage = await readLatestRecentSessionUsageFromTranscriptAsync(
      params.parentEntry.sessionId,
      params.storePath,
      params.parentEntry.sessionFile,
      undefined,
      1024 * 1024,
    );
    const promptTokens = resolvePositiveTokenCount(
      derivePromptTokens({
        input: usage?.inputTokens,
        cacheRead: usage?.cacheRead,
        cacheWrite: usage?.cacheWrite,
      }),
    );
    const outputTokens = resolvePositiveTokenCount(usage?.outputTokens);
    if (typeof promptTokens === "number") {
      return maxPositiveTokenCount(
        promptTokens + (outputTokens ?? 0),
        cachedTokens,
        byteEstimateTokens,
      );
    }
  } catch {
    // Fall back to cached totals when recent transcript usage cannot be read.
  }

  return maxPositiveTokenCount(cachedTokens, byteEstimateTokens);
}

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

function hasAssistantEntry(entries: unknown[]): boolean {
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

async function readForkSourceTranscript(
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

async function writeForkHeaderOnly(params: {
  parentSessionFile: string;
  sessionDir: string;
  cwd: string;
}): Promise<{ sessionId: string; sessionFile: string }> {
  const sessionId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const sessionFile = path.join(params.sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp,
    cwd: params.cwd,
    parentSession: params.parentSessionFile,
  } satisfies SessionHeader;
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, `${JSON.stringify(header)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
    flag: "wx",
  });
  return { sessionId, sessionFile };
}

async function writeBranchedSession(params: {
  parentSessionFile: string;
  source: ForkSourceTranscript;
}): Promise<{ sessionId: string; sessionFile: string }> {
  const sessionId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const sessionFile = path.join(params.source.sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
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
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp,
    cwd: params.source.cwd,
    parentSession: params.parentSessionFile,
  } satisfies SessionHeader;
  const leafEntry = params.source.preserveLeafControl
    ? {
        type: "leaf",
        id: generateEntryId(pathEntryIds),
        parentId: labelEntries.at(-1)?.id ?? lastPathEntryId,
        timestamp,
        targetId: params.source.leafId,
        appendParentId: params.source.appendParentId,
        ...(params.source.appendMode ? { appendMode: params.source.appendMode } : {}),
      }
    : null;
  const entries = [header, ...pathEntries, ...labelEntries, ...(leafEntry ? [leafEntry] : [])];
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
    encoding: "utf-8",
    mode: 0o600,
    flag: "wx",
  });
  return { sessionId, sessionFile };
}

/** Creates a child session transcript from a parent session branch. */
export async function forkSessionFromParentRuntime(params: {
  parentEntry: StoreSessionEntry;
  agentId: string;
  sessionsDir: string;
}): Promise<{ sessionId: string; sessionFile: string } | null> {
  const parentSessionFile = resolveSessionFilePath(
    params.parentEntry.sessionId,
    params.parentEntry,
    { agentId: params.agentId, sessionsDir: params.sessionsDir },
  );
  if (!parentSessionFile) {
    return null;
  }
  try {
    const source = await readForkSourceTranscript(parentSessionFile);
    if (!source) {
      return null;
    }
    const shouldPersistBranch =
      source.preserveLeafControl || hasAssistantEntry(source.branchEntries);
    return shouldPersistBranch
      ? await writeBranchedSession({ parentSessionFile, source })
      : await writeForkHeaderOnly({
          parentSessionFile,
          sessionDir: source.sessionDir,
          cwd: source.cwd,
        });
  } catch {
    return null;
  }
}
