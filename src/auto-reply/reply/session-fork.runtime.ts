import crypto from "node:crypto";
import {
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
  type FileEntry,
  type SessionEntry as PiSessionEntry,
  type SessionHeader,
} from "../../agents/transcript/session-transcript-contract.js";
import { derivePromptTokens } from "../../agents/usage.js";
import {
  createSqliteSessionTranscriptLocator,
  isSqliteSessionTranscriptLocator,
} from "../../config/sessions/paths.js";
import {
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
  resolveSqliteSessionTranscriptScope,
} from "../../config/sessions/transcript-store.sqlite.js";
import {
  resolveFreshSessionTotalTokens,
  type SessionEntry as StoreSessionEntry,
} from "../../config/sessions/types.js";
import { readLatestRecentSessionUsageFromTranscriptAsync } from "../../gateway/session-utils.fs.js";

type ForkSourceTranscript = {
  agentId: string;
  cwd: string;
  leafId: string | null;
  branchEntries: PiSessionEntry[];
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

async function estimateParentTranscriptTokensFromSqlite(params: {
  parentEntry: StoreSessionEntry;
  agentId: string;
}): Promise<number | undefined> {
  try {
    const filePath = resolveForkParentSessionFile(params.parentEntry, params.agentId);
    const scope = resolveSqliteSessionTranscriptScope({
      agentId: params.agentId,
      sessionId: params.parentEntry.sessionId,
      transcriptPath: filePath,
    });
    if (!scope) {
      return undefined;
    }
    const size = loadSqliteSessionTranscriptEvents(scope).reduce(
      (total, entry) => total + JSON.stringify(entry.event).length + 1,
      0,
    );
    return resolvePositiveTokenCount(Math.ceil(size / FALLBACK_TRANSCRIPT_BYTES_PER_TOKEN));
  } catch {
    return undefined;
  }
}

function resolveForkParentSessionFile(parentEntry: StoreSessionEntry, agentId: string): string {
  const sessionFile = parentEntry.sessionFile?.trim();
  if (sessionFile && isSqliteSessionTranscriptLocator(sessionFile)) {
    return sessionFile;
  }
  return createSqliteSessionTranscriptLocator({ agentId, sessionId: parentEntry.sessionId });
}

export async function resolveParentForkTokenCountRuntime(params: {
  parentEntry: StoreSessionEntry;
  agentId: string;
}): Promise<number | undefined> {
  const freshPersistedTokens = resolveFreshSessionTotalTokens(params.parentEntry);
  if (typeof freshPersistedTokens === "number") {
    return freshPersistedTokens;
  }

  const cachedTokens = resolvePositiveTokenCount(params.parentEntry.totalTokens);
  const byteEstimateTokens = await estimateParentTranscriptTokensFromSqlite(params);
  try {
    const usage = await readLatestRecentSessionUsageFromTranscriptAsync(
      params.parentEntry.sessionId,
      params.parentEntry.sessionFile,
      params.agentId,
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

function isSessionEntry(entry: FileEntry): entry is PiSessionEntry {
  return (
    entry.type !== "session" &&
    typeof (entry as { id?: unknown }).id === "string" &&
    (typeof (entry as { timestamp?: unknown }).timestamp === "string" ||
      typeof (entry as { timestamp?: unknown }).timestamp === "number")
  );
}

function buildEntryIndex(entries: PiSessionEntry[]): Map<string, PiSessionEntry> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

function readBranch(params: {
  byId: Map<string, PiSessionEntry>;
  leafId: string | null;
}): PiSessionEntry[] {
  const branchEntries: PiSessionEntry[] = [];
  let current = params.leafId ? params.byId.get(params.leafId) : undefined;
  while (current) {
    branchEntries.unshift(current);
    current = current.parentId ? params.byId.get(current.parentId) : undefined;
  }
  return branchEntries;
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

function collectBranchLabels(params: {
  allEntries: PiSessionEntry[];
  pathEntryIds: Set<string>;
}): Array<{ targetId: string; label: string; timestamp: string }> {
  const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
  for (const entry of params.allEntries) {
    if (
      entry.type === "label" &&
      entry.label &&
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

async function readForkSourceTranscript(params: {
  parentSessionFile: string;
  agentId: string;
  sessionId: string;
}): Promise<ForkSourceTranscript | null> {
  const fileEntries = loadSqliteSessionTranscriptEvents({
    agentId: params.agentId,
    sessionId: params.sessionId,
  }).map((entry) => entry.event as FileEntry);
  if (fileEntries.length === 0) {
    return null;
  }
  migrateSessionEntries(fileEntries);
  const header =
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  const entries = fileEntries.filter(isSessionEntry);
  const byId = buildEntryIndex(entries);
  const leafId = entries.at(-1)?.id ?? null;
  const branchEntries = readBranch({ byId, leafId });
  const pathEntryIds = new Set(
    branchEntries.filter((entry) => entry.type !== "label").map((entry) => entry.id),
  );
  return {
    agentId: params.agentId,
    cwd: header?.cwd ?? process.cwd(),
    leafId,
    branchEntries,
    labelsToWrite: collectBranchLabels({ allEntries: entries, pathEntryIds }),
  };
}

function buildBranchLabelEntries(params: {
  labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }>;
  pathEntryIds: Set<string>;
  lastEntryId: string | null;
}): PiSessionEntry[] {
  let parentId = params.lastEntryId;
  const labelEntries: PiSessionEntry[] = [];
  for (const { targetId, label, timestamp } of params.labelsToWrite) {
    const labelEntry = {
      type: "label",
      id: generateEntryId(params.pathEntryIds),
      parentId,
      timestamp,
      targetId,
      label,
    } satisfies PiSessionEntry;
    params.pathEntryIds.add(labelEntry.id);
    labelEntries.push(labelEntry);
    parentId = labelEntry.id;
  }
  return labelEntries;
}

async function writeForkHeaderOnly(params: {
  parentSessionFile: string;
  agentId: string;
  cwd: string;
}): Promise<{ sessionId: string; sessionFile: string }> {
  const sessionId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const sessionFile = createSqliteSessionTranscriptLocator({
    agentId: params.agentId,
    sessionId,
  });
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp,
    cwd: params.cwd,
    parentSession: params.parentSessionFile,
  } satisfies SessionHeader;
  replaceSqliteSessionTranscriptEvents({
    agentId: params.agentId,
    sessionId,
    transcriptPath: sessionFile,
    events: [header],
  });
  return { sessionId, sessionFile };
}

async function writeBranchedSession(params: {
  parentSessionFile: string;
  source: ForkSourceTranscript;
}): Promise<{ sessionId: string; sessionFile: string }> {
  const sessionId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const sessionFile = createSqliteSessionTranscriptLocator({
    agentId: params.source.agentId,
    sessionId,
  });
  const pathWithoutLabels = params.source.branchEntries.filter((entry) => entry.type !== "label");
  const pathEntryIds = new Set(pathWithoutLabels.map((entry) => entry.id));
  const labelEntries = buildBranchLabelEntries({
    labelsToWrite: params.source.labelsToWrite,
    pathEntryIds,
    lastEntryId: pathWithoutLabels.at(-1)?.id ?? null,
  });
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp,
    cwd: params.source.cwd,
    parentSession: params.parentSessionFile,
  } satisfies SessionHeader;
  const entries = [header, ...pathWithoutLabels, ...labelEntries];
  const hasAssistant = entries.some(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  if (hasAssistant) {
    replaceSqliteSessionTranscriptEvents({
      agentId: params.source.agentId,
      sessionId,
      transcriptPath: sessionFile,
      events: entries,
    });
  }
  return { sessionId, sessionFile };
}

export async function forkSessionFromParentRuntime(params: {
  parentEntry: StoreSessionEntry;
  agentId: string;
}): Promise<{ sessionId: string; sessionFile: string } | null> {
  const parentSessionFile = resolveForkParentSessionFile(params.parentEntry, params.agentId);
  if (!parentSessionFile) {
    return null;
  }
  try {
    const source = await readForkSourceTranscript({
      parentSessionFile,
      agentId: params.agentId,
      sessionId: params.parentEntry.sessionId,
    });
    if (!source) {
      return null;
    }
    return source.leafId
      ? await writeBranchedSession({ parentSessionFile, source })
      : await writeForkHeaderOnly({
          parentSessionFile,
          agentId: source.agentId,
          cwd: source.cwd,
        });
  } catch {
    return null;
  }
}
