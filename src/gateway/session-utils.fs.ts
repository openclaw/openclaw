import fs from "node:fs";
import { deriveSessionTotalTokens, hasNonzeroUsage, normalizeUsage } from "../agents/usage.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import { extractToolCallNames, hasToolCall } from "../utils/transcript-tools.js";
import { stripEnvelope } from "./chat-sanitize.js";
import {
  resolveSessionTranscriptCandidates,
  archiveFileOnDisk,
  archiveSessionTranscripts,
  cleanupArchivedSessionTranscripts,
} from "./session-transcript-files.fs.js";
import type { SessionPreviewItem } from "./session-utils.types.js";

type SessionTitleFields = {
  firstUserMessage: string | null;
  lastMessagePreview: string | null;
};

type FileStatLike = {
  mtimeMs: number;
  size: number;
};

type SessionTitleFieldsCacheEntry = SessionTitleFields & {
  mtimeMs: number;
  size: number;
};

const sessionTitleFieldsCache = new Map<string, SessionTitleFieldsCacheEntry>();
const MAX_SESSION_TITLE_FIELDS_CACHE_ENTRIES = 5000;

function readSessionTitleFieldsCacheKey(
  filePath: string,
  opts?: { includeInterSession?: boolean },
) {
  const includeInterSession = opts?.includeInterSession === true ? "1" : "0";
  return `${filePath}\t${includeInterSession}`;
}

function getCachedSessionTitleFields(
  cacheKey: string,
  stat: FileStatLike,
): SessionTitleFields | null {
  const cached = sessionTitleFieldsCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
    sessionTitleFieldsCache.delete(cacheKey);
    return null;
  }
  // LRU bump
  sessionTitleFieldsCache.delete(cacheKey);
  sessionTitleFieldsCache.set(cacheKey, cached);
  return {
    firstUserMessage: cached.firstUserMessage,
    lastMessagePreview: cached.lastMessagePreview,
  };
}

function setCachedSessionTitleFields(
  cacheKey: string,
  stat: FileStatLike,
  value: SessionTitleFields,
) {
  sessionTitleFieldsCache.set(cacheKey, {
    ...value,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  });
  while (sessionTitleFieldsCache.size > MAX_SESSION_TITLE_FIELDS_CACHE_ENTRIES) {
    const oldestKey = sessionTitleFieldsCache.keys().next().value;
    if (typeof oldestKey !== "string" || !oldestKey) {
      break;
    }
    sessionTitleFieldsCache.delete(oldestKey);
  }
}

export function attachOpenClawTranscriptMeta(
  message: unknown,
  meta: Record<string, unknown>,
): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return message;
  }
  const record = message as Record<string, unknown>;
  const existing =
    record.__openclaw && typeof record.__openclaw === "object" && !Array.isArray(record.__openclaw)
      ? (record.__openclaw as Record<string, unknown>)
      : {};
  return {
    ...record,
    __openclaw: {
      ...existing,
      ...meta,
    },
  };
}

export function readSessionMessages(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
): unknown[] {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile);

  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) {
    return [];
  }

  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  const messages: unknown[] = [];
  let messageSeq = 0;
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed?.message) {
        messageSeq += 1;
        messages.push(
          attachOpenClawTranscriptMeta(parsed.message, {
            ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
            seq: messageSeq,
          }),
        );
        continue;
      }

      // Compaction entries are not "message" records, but they're useful context for debugging.
      // Emit a lightweight synthetic message that the Web UI can render as a divider.
      if (parsed?.type === "compaction") {
        const ts = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
        const timestamp = Number.isFinite(ts) ? ts : Date.now();
        messageSeq += 1;
        messages.push({
          role: "system",
          content: [{ type: "text", text: "Compaction" }],
          timestamp,
          __openclaw: {
            kind: "compaction",
            id: typeof parsed.id === "string" ? parsed.id : undefined,
            seq: messageSeq,
          },
        });
      }
    } catch {
      // ignore bad lines
    }
  }
  return messages;
}

export {
  archiveFileOnDisk,
  archiveSessionTranscripts,
  cleanupArchivedSessionTranscripts,
  resolveSessionTranscriptCandidates,
} from "./session-transcript-files.fs.js";

export function capArrayByJsonBytes<T>(
  items: T[],
  maxBytes: number,
): { items: T[]; bytes: number } {
  if (items.length === 0) {
    return { items, bytes: 2 };
  }
  const parts = items.map((item) => jsonUtf8Bytes(item));
  let bytes = 2 + parts.reduce((a, b) => a + b, 0) + (items.length - 1);
  let start = 0;
  while (bytes > maxBytes && start < items.length - 1) {
    bytes -= parts[start] + 1;
    start += 1;
  }
  const next = start > 0 ? items.slice(start) : items;
  return { items: next, bytes };
}

const MAX_LINES_TO_SCAN = 10;

type TranscriptMessage = {
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
  provenance?: unknown;
};

export function readSessionTitleFieldsFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
  opts?: { includeInterSession?: boolean },
): SessionTitleFields {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) {
    return { firstUserMessage: null, lastMessagePreview: null };
  }

  const cacheKey = readSessionTitleFieldsCacheKey(filePath, opts);
  let pathStat: fs.Stats;
  try {
    pathStat = fs.statSync(filePath);
  } catch {
    return { firstUserMessage: null, lastMessagePreview: null };
  }
  const cached = getCachedSessionTitleFields(cacheKey, pathStat);
  if (cached) {
    return cached;
  }
  if (pathStat.size === 0) {
    const empty = { firstUserMessage: null, lastMessagePreview: null };
    setCachedSessionTitleFields(cacheKey, pathStat, empty);
    return empty;
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) {
      const empty = { firstUserMessage: null, lastMessagePreview: null };
      setCachedSessionTitleFields(cacheKey, stat, empty);
      return empty;
    }
    const size = stat.size;

    // Head (first user message)
    let firstUserMessage: string | null = null;
    try {
      const chunk = readTranscriptHeadChunk(fd);
      if (chunk) {
        firstUserMessage = extractFirstUserMessageFromTranscriptChunk(chunk, opts);
      }
    } catch {
      // ignore head read errors
    }

    // Tail (last message preview)
    let lastMessagePreview: string | null = null;
    try {
      lastMessagePreview = readLastMessagePreviewFromOpenTranscript({ fd, size });
    } catch {
      // ignore tail read errors
    }

    const result = { firstUserMessage, lastMessagePreview };
    setCachedSessionTitleFields(cacheKey, stat, result);
    return result;
  } catch {
    return { firstUserMessage: null, lastMessagePreview: null };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export async function readSessionTitleFieldsFromTranscriptAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
  opts?: { includeInterSession?: boolean },
): Promise<SessionTitleFields> {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) {
    return { firstUserMessage: null, lastMessagePreview: null };
  }

  const cacheKey = readSessionTitleFieldsCacheKey(filePath, opts);
  let pathStat: fs.Stats;
  try {
    pathStat = await fs.promises.stat(filePath);
  } catch {
    return { firstUserMessage: null, lastMessagePreview: null };
  }
  const cached = getCachedSessionTitleFields(cacheKey, pathStat);
  if (cached) {
    return cached;
  }
  if (pathStat.size === 0) {
    const empty = { firstUserMessage: null, lastMessagePreview: null };
    setCachedSessionTitleFields(cacheKey, pathStat, empty);
    return empty;
  }

  let fileHandle: fs.promises.FileHandle | null = null;
  try {
    fileHandle = await fs.promises.open(filePath, "r");
    const stat = await fileHandle.stat();
    if (stat.size === 0) {
      const empty = { firstUserMessage: null, lastMessagePreview: null };
      setCachedSessionTitleFields(cacheKey, stat, empty);
      return empty;
    }
    const size = stat.size;

    let firstUserMessage: string | null = null;
    try {
      const chunk = await readTranscriptHeadChunkAsync(fileHandle);
      if (chunk) {
        firstUserMessage = extractFirstUserMessageFromTranscriptChunk(chunk, opts);
      }
    } catch {
      // ignore head read errors
    }

    let lastMessagePreview: string | null = null;
    try {
      lastMessagePreview = await readLastMessagePreviewFromOpenTranscriptAsync({
        fileHandle,
        size,
      });
    } catch {
      // ignore tail read errors
    }

    const result = { firstUserMessage, lastMessagePreview };
    setCachedSessionTitleFields(cacheKey, stat, result);
    return result;
  } catch {
    return { firstUserMessage: null, lastMessagePreview: null };
  } finally {
    if (fileHandle) {
      await fileHandle.close().catch(() => {});
    }
  }
}

function extractTextFromContent(content: TranscriptMessage["content"]): string | null {
  if (typeof content === "string") {
    const normalized = stripInlineDirectiveTagsForDisplay(content).text.trim();
    return normalized || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  for (const part of content) {
    if (!part || typeof part.text !== "string") {
      continue;
    }
    if (part.type === "text" || part.type === "output_text" || part.type === "input_text") {
      const normalized = stripInlineDirectiveTagsForDisplay(part.text).text.trim();
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
}

function readTranscriptHeadChunk(fd: number, maxBytes = 8192): string | null {
  const buf = Buffer.alloc(maxBytes);
  const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
  if (bytesRead <= 0) {
    return null;
  }
  return buf.toString("utf-8", 0, bytesRead);
}

async function readTranscriptHeadChunkAsync(
  fileHandle: fs.promises.FileHandle,
  maxBytes = 8192,
): Promise<string | null> {
  const buf = Buffer.alloc(maxBytes);
  const { bytesRead } = await fileHandle.read(buf, 0, buf.length, 0);
  if (bytesRead <= 0) {
    return null;
  }
  return buf.toString("utf-8", 0, bytesRead);
}

function extractFirstUserMessageFromTranscriptChunk(
  chunk: string,
  opts?: { includeInterSession?: boolean },
): string | null {
  const lines = chunk.split(/\r?\n/).slice(0, MAX_LINES_TO_SCAN);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      const msg = parsed?.message as TranscriptMessage | undefined;
      if (msg?.role !== "user") {
        continue;
      }
      if (opts?.includeInterSession !== true && hasInterSessionUserProvenance(msg)) {
        continue;
      }
      const text = extractTextFromContent(msg.content);
      if (text) {
        return text;
      }
    } catch {
      // skip malformed lines
    }
  }
  return null;
}

function findExistingTranscriptPath(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string | null {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function withOpenTranscriptFd<T>(filePath: string, read: (fd: number) => T | null): T | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    return read(fd);
  } catch {
    // file read error
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
  return null;
}

export function readFirstUserMessageFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
  opts?: { includeInterSession?: boolean },
): string | null {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return null;
  }

  return withOpenTranscriptFd(filePath, (fd) => {
    const chunk = readTranscriptHeadChunk(fd);
    if (!chunk) {
      return null;
    }
    return extractFirstUserMessageFromTranscriptChunk(chunk, opts);
  });
}

const LAST_MSG_MAX_BYTES = 16384;
const LAST_MSG_MAX_LINES = 20;

function readLastMessagePreviewFromOpenTranscript(params: {
  fd: number;
  size: number;
}): string | null {
  const readStart = Math.max(0, params.size - LAST_MSG_MAX_BYTES);
  const readLen = Math.min(params.size, LAST_MSG_MAX_BYTES);
  const buf = Buffer.alloc(readLen);
  fs.readSync(params.fd, buf, 0, readLen, readStart);

  const chunk = buf.toString("utf-8");
  const lines = chunk.split(/\r?\n/).filter((l) => l.trim());
  const tailLines = lines.slice(-LAST_MSG_MAX_LINES);

  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i];
    try {
      const parsed = JSON.parse(line);
      const msg = parsed?.message as TranscriptMessage | undefined;
      if (msg?.role !== "user" && msg?.role !== "assistant") {
        continue;
      }
      const text = extractTextFromContent(msg.content);
      if (text) {
        return text;
      }
    } catch {
      // skip malformed
    }
  }
  return null;
}

async function readLastMessagePreviewFromOpenTranscriptAsync(params: {
  fileHandle: fs.promises.FileHandle;
  size: number;
}): Promise<string | null> {
  const readStart = Math.max(0, params.size - LAST_MSG_MAX_BYTES);
  const readLen = Math.min(params.size, LAST_MSG_MAX_BYTES);
  const buf = Buffer.alloc(readLen);
  await params.fileHandle.read(buf, 0, readLen, readStart);

  const chunk = buf.toString("utf-8");
  const lines = chunk.split(/\r?\n/).filter((l) => l.trim());
  const tailLines = lines.slice(-LAST_MSG_MAX_LINES);

  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i];
    try {
      const parsed = JSON.parse(line);
      const msg = parsed?.message as TranscriptMessage | undefined;
      if (msg?.role !== "user" && msg?.role !== "assistant") {
        continue;
      }
      const text = extractTextFromContent(msg.content);
      if (text) {
        return text;
      }
    } catch {
      // skip malformed
    }
  }
  return null;
}

export function readLastMessagePreviewFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string | null {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return null;
  }

  return withOpenTranscriptFd(filePath, (fd) => {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (size === 0) {
      return null;
    }
    return readLastMessagePreviewFromOpenTranscript({ fd, size });
  });
}

export type SessionTranscriptUsageSnapshot = {
  modelProvider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  costUsd?: number;
};

function extractTranscriptUsageCost(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const cost = (raw as { cost?: unknown }).cost;
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) {
    return undefined;
  }
  const total = (cost as { total?: unknown }).total;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : undefined;
}

function resolvePositiveUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

type TranscriptUsageAccumulator = {
  snapshot: SessionTranscriptUsageSnapshot;
  sawSnapshot: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  sawInputTokens: boolean;
  sawOutputTokens: boolean;
  sawCacheRead: boolean;
  sawCacheWrite: boolean;
  costUsdTotal: number;
  sawCost: boolean;
};

function createTranscriptUsageAccumulator(): TranscriptUsageAccumulator {
  return {
    snapshot: {},
    sawSnapshot: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    sawInputTokens: false,
    sawOutputTokens: false,
    sawCacheRead: false,
    sawCacheWrite: false,
    costUsdTotal: 0,
    sawCost: false,
  };
}

function accumulateTranscriptUsageLine(state: TranscriptUsageAccumulator, line: string): void {
  if (line.trim().length === 0) {
    return;
  }
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const message =
      parsed.message && typeof parsed.message === "object" && !Array.isArray(parsed.message)
        ? (parsed.message as Record<string, unknown>)
        : undefined;
    if (!message) {
      return;
    }
    const role = typeof message.role === "string" ? message.role : undefined;
    if (role && role !== "assistant") {
      return;
    }
    const usageRaw =
      message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
        ? message.usage
        : parsed.usage && typeof parsed.usage === "object" && !Array.isArray(parsed.usage)
          ? parsed.usage
          : undefined;
    const usage = normalizeUsage(usageRaw);
    const totalTokens = resolvePositiveUsageNumber(deriveSessionTotalTokens({ usage }));
    const costUsd = extractTranscriptUsageCost(usageRaw);
    const modelProvider =
      typeof message.provider === "string"
        ? message.provider.trim()
        : typeof parsed.provider === "string"
          ? parsed.provider.trim()
          : undefined;
    const model =
      typeof message.model === "string"
        ? message.model.trim()
        : typeof parsed.model === "string"
          ? parsed.model.trim()
          : undefined;
    const isDeliveryMirror = modelProvider === "openclaw" && model === "delivery-mirror";
    const hasMeaningfulUsage =
      hasNonzeroUsage(usage) ||
      typeof totalTokens === "number" ||
      (typeof costUsd === "number" && Number.isFinite(costUsd));
    const hasModelIdentity = Boolean(modelProvider || model);
    if (!hasMeaningfulUsage && !hasModelIdentity) {
      return;
    }
    if (isDeliveryMirror && !hasMeaningfulUsage) {
      return;
    }

    state.sawSnapshot = true;
    if (!isDeliveryMirror) {
      if (modelProvider) {
        state.snapshot.modelProvider = modelProvider;
      }
      if (model) {
        state.snapshot.model = model;
      }
    }
    if (typeof usage?.input === "number" && Number.isFinite(usage.input)) {
      state.inputTokens += usage.input;
      state.sawInputTokens = true;
    }
    if (typeof usage?.output === "number" && Number.isFinite(usage.output)) {
      state.outputTokens += usage.output;
      state.sawOutputTokens = true;
    }
    if (typeof usage?.cacheRead === "number" && Number.isFinite(usage.cacheRead)) {
      state.cacheRead += usage.cacheRead;
      state.sawCacheRead = true;
    }
    if (typeof usage?.cacheWrite === "number" && Number.isFinite(usage.cacheWrite)) {
      state.cacheWrite += usage.cacheWrite;
      state.sawCacheWrite = true;
    }
    if (typeof totalTokens === "number") {
      state.snapshot.totalTokens = totalTokens;
      state.snapshot.totalTokensFresh = true;
    }
    if (typeof costUsd === "number" && Number.isFinite(costUsd)) {
      state.costUsdTotal += costUsd;
      state.sawCost = true;
    }
  } catch {
    // skip malformed lines
  }
}

function finalizeTranscriptUsageAccumulator(
  state: TranscriptUsageAccumulator,
): SessionTranscriptUsageSnapshot | null {
  if (!state.sawSnapshot) {
    return null;
  }
  if (state.sawInputTokens) {
    state.snapshot.inputTokens = state.inputTokens;
  }
  if (state.sawOutputTokens) {
    state.snapshot.outputTokens = state.outputTokens;
  }
  if (state.sawCacheRead) {
    state.snapshot.cacheRead = state.cacheRead;
  }
  if (state.sawCacheWrite) {
    state.snapshot.cacheWrite = state.cacheWrite;
  }
  if (state.sawCost) {
    state.snapshot.costUsd = state.costUsdTotal;
  }
  return state.snapshot;
}

function extractLatestUsageFromTranscriptChunk(
  chunk: string,
): SessionTranscriptUsageSnapshot | null {
  const state = createTranscriptUsageAccumulator();
  const maxLineChars = getSessionUsageTranscriptMaxLineChars();
  for (const line of chunk.split(/\r?\n/)) {
    if (line.length > maxLineChars) {
      return null;
    }
    accumulateTranscriptUsageLine(state, line);
  }
  return finalizeTranscriptUsageAccumulator(state);
}

type SessionUsageCacheEntry = {
  result: SessionTranscriptUsageSnapshot | null;
  mtimeMs: number;
  size: number;
};

const sessionUsageCache = new Map<string, SessionUsageCacheEntry>();
const DEFAULT_SESSION_USAGE_CACHE_MAX_ENTRIES = 5000;
export const MAX_SESSION_USAGE_CACHE_MAX_ENTRIES = 100_000;
const DEFAULT_SESSION_USAGE_TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_SESSION_USAGE_TRANSCRIPT_MAX_LINE_CHARS = 1 * 1024 * 1024;
export const MAX_SESSION_USAGE_TRANSCRIPT_BYTES = 128 * 1024 * 1024;
export const MAX_SESSION_USAGE_TRANSCRIPT_LINE_CHARS = 8 * 1024 * 1024;
let configuredSessionUsageCacheMaxEntries: number | undefined;
let configuredSessionUsageTranscriptMaxBytes: number | undefined;
let configuredSessionUsageTranscriptMaxLineChars: number | undefined;

export function applyConfiguredSessionUsageGuardrails(config: {
  gateway?: {
    sessionsList?: {
      usageCacheMaxEntries?: number;
      transcriptUsageMaxBytes?: number;
      transcriptUsageMaxLineChars?: number;
    };
  };
}) {
  setSessionUsageCacheMaxEntries(config.gateway?.sessionsList?.usageCacheMaxEntries);
  setSessionUsageTranscriptMaxBytes(config.gateway?.sessionsList?.transcriptUsageMaxBytes);
  setSessionUsageTranscriptMaxLineChars(config.gateway?.sessionsList?.transcriptUsageMaxLineChars);
}

export function setSessionUsageCacheMaxEntries(value: number | undefined) {
  configuredSessionUsageCacheMaxEntries =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.min(value, MAX_SESSION_USAGE_CACHE_MAX_ENTRIES)
      : undefined;
  // Trim cache immediately when the limit is lowered so memory is released
  // on in-process gateway restarts without waiting for new writes.
  const maxEntries = getSessionUsageCacheMaxEntries();
  while (sessionUsageCache.size > maxEntries) {
    const oldestKey = sessionUsageCache.keys().next().value;
    if (typeof oldestKey !== "string" || !oldestKey) {
      break;
    }
    sessionUsageCache.delete(oldestKey);
  }
}

export function getSessionUsageCacheMaxEntries(): number {
  return configuredSessionUsageCacheMaxEntries ?? DEFAULT_SESSION_USAGE_CACHE_MAX_ENTRIES;
}

export function getSessionTitleFieldsCacheMaxEntries(): number {
  return MAX_SESSION_TITLE_FIELDS_CACHE_ENTRIES;
}

export function setSessionUsageTranscriptMaxBytes(value: number | undefined) {
  const nextValue =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.min(value, MAX_SESSION_USAGE_TRANSCRIPT_BYTES)
      : undefined;
  if (configuredSessionUsageTranscriptMaxBytes !== nextValue) {
    configuredSessionUsageTranscriptMaxBytes = nextValue;
    sessionUsageCache.clear();
  }
}

export function getSessionUsageTranscriptMaxBytes(): number {
  return configuredSessionUsageTranscriptMaxBytes ?? DEFAULT_SESSION_USAGE_TRANSCRIPT_MAX_BYTES;
}

export function setSessionUsageTranscriptMaxLineChars(value: number | undefined) {
  const nextValue =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.min(value, MAX_SESSION_USAGE_TRANSCRIPT_LINE_CHARS)
      : undefined;
  if (configuredSessionUsageTranscriptMaxLineChars !== nextValue) {
    configuredSessionUsageTranscriptMaxLineChars = nextValue;
    sessionUsageCache.clear();
  }
}

export function getSessionUsageTranscriptMaxLineChars(): number {
  return (
    configuredSessionUsageTranscriptMaxLineChars ?? DEFAULT_SESSION_USAGE_TRANSCRIPT_MAX_LINE_CHARS
  );
}

function getCachedSessionUsage(
  cacheKey: string,
  stat: fs.Stats,
): SessionTranscriptUsageSnapshot | null | undefined {
  const cached = sessionUsageCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  if (cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
    sessionUsageCache.delete(cacheKey);
    return undefined;
  }
  // LRU bump
  sessionUsageCache.delete(cacheKey);
  sessionUsageCache.set(cacheKey, cached);
  return cached.result;
}

function setCachedSessionUsage(
  cacheKey: string,
  stat: fs.Stats,
  result: SessionTranscriptUsageSnapshot | null,
) {
  sessionUsageCache.set(cacheKey, {
    result,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  });
  const maxEntries = getSessionUsageCacheMaxEntries();
  while (sessionUsageCache.size > maxEntries) {
    const oldestKey = sessionUsageCache.keys().next().value;
    if (typeof oldestKey !== "string" || !oldestKey) {
      break;
    }
    sessionUsageCache.delete(oldestKey);
  }
}

export function readLatestSessionUsageFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): SessionTranscriptUsageSnapshot | null {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return null;
  }

  return withOpenTranscriptFd(filePath, (fd) => {
    const stat = fs.fstatSync(fd);
    const cached = getCachedSessionUsage(filePath, stat);
    if (cached !== undefined) {
      return cached;
    }
    if (stat.size === 0) {
      setCachedSessionUsage(filePath, stat, null);
      return null;
    }
    if (stat.size > getSessionUsageTranscriptMaxBytes()) {
      setCachedSessionUsage(filePath, stat, null);
      return null;
    }
    const chunk = fs.readFileSync(fd, "utf-8");
    const result = extractLatestUsageFromTranscriptChunk(chunk);
    setCachedSessionUsage(filePath, stat, result);
    return result;
  });
}

async function readLatestSessionUsageFromStream(params: {
  stream: fs.ReadStream;
  maxLineChars: number;
}): Promise<SessionTranscriptUsageSnapshot | null> {
  const { stream, maxLineChars } = params;
  const state = createTranscriptUsageAccumulator();
  let pending = "";
  try {
    for await (const chunk of stream) {
      pending += chunk;
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex >= 0) {
        let line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }
        if (line.length > maxLineChars) {
          return null;
        }
        accumulateTranscriptUsageLine(state, line);
        newlineIndex = pending.indexOf("\n");
      }
      if (pending.length > maxLineChars) {
        return null;
      }
    }

    let tail = pending;
    if (tail.endsWith("\r")) {
      tail = tail.slice(0, -1);
    }
    if (tail.length > maxLineChars) {
      return null;
    }
    accumulateTranscriptUsageLine(state, tail);
    return finalizeTranscriptUsageAccumulator(state);
  } finally {
    if (!stream.destroyed) {
      stream.destroy();
    }
  }
}

export async function readLatestSessionUsageFromTranscriptAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): Promise<SessionTranscriptUsageSnapshot | null> {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return null;
  }

  let fileHandle: fs.promises.FileHandle | null = null;
  try {
    fileHandle = await fs.promises.open(filePath, "r");
    const stat = await fileHandle.stat();
    const cached = getCachedSessionUsage(filePath, stat);
    if (cached !== undefined) {
      return cached;
    }
    if (stat.size === 0) {
      setCachedSessionUsage(filePath, stat, null);
      return null;
    }
    if (stat.size > getSessionUsageTranscriptMaxBytes()) {
      setCachedSessionUsage(filePath, stat, null);
      return null;
    }
    const maxLineChars = getSessionUsageTranscriptMaxLineChars();
    const stream = fileHandle.createReadStream({
      encoding: "utf-8",
      start: 0,
      end: stat.size - 1,
    });
    const result = await readLatestSessionUsageFromStream({
      stream,
      maxLineChars,
    });
    setCachedSessionUsage(filePath, stat, result);
    return result;
  } catch {
    return null;
  } finally {
    if (fileHandle) {
      await fileHandle.close().catch(() => {});
    }
  }
}

const PREVIEW_READ_SIZES = [64 * 1024, 256 * 1024, 1024 * 1024];
const PREVIEW_MAX_LINES = 200;

type TranscriptContentEntry = {
  type?: string;
  text?: string;
  name?: string;
};

type TranscriptPreviewMessage = {
  role?: string;
  content?: string | TranscriptContentEntry[];
  text?: string;
  toolName?: string;
  tool_name?: string;
};

function normalizeRole(role: string | undefined, isTool: boolean): SessionPreviewItem["role"] {
  if (isTool) {
    return "tool";
  }
  switch ((role ?? "").toLowerCase()) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "tool":
      return "tool";
    default:
      return "other";
  }
}

function truncatePreviewText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 3)}...`;
}

function extractPreviewText(message: TranscriptPreviewMessage): string | null {
  if (typeof message.content === "string") {
    const normalized = stripInlineDirectiveTagsForDisplay(message.content).text.trim();
    return normalized ? normalized : null;
  }
  if (Array.isArray(message.content)) {
    const parts = message.content
      .map((entry) =>
        typeof entry?.text === "string" ? stripInlineDirectiveTagsForDisplay(entry.text).text : "",
      )
      .filter((text) => text.trim().length > 0);
    if (parts.length > 0) {
      return parts.join("\n").trim();
    }
  }
  if (typeof message.text === "string") {
    const normalized = stripInlineDirectiveTagsForDisplay(message.text).text.trim();
    return normalized ? normalized : null;
  }
  return null;
}

function isToolCall(message: TranscriptPreviewMessage): boolean {
  return hasToolCall(message as Record<string, unknown>);
}

function extractToolNames(message: TranscriptPreviewMessage): string[] {
  return extractToolCallNames(message as Record<string, unknown>);
}

function extractMediaSummary(message: TranscriptPreviewMessage): string | null {
  if (!Array.isArray(message.content)) {
    return null;
  }
  for (const entry of message.content) {
    const raw = typeof entry?.type === "string" ? entry.type.trim().toLowerCase() : "";
    if (!raw || raw === "text" || raw === "toolcall" || raw === "tool_call") {
      continue;
    }
    return `[${raw}]`;
  }
  return null;
}

function buildPreviewItems(
  messages: TranscriptPreviewMessage[],
  maxItems: number,
  maxChars: number,
): SessionPreviewItem[] {
  const items: SessionPreviewItem[] = [];
  for (const message of messages) {
    const toolCall = isToolCall(message);
    const role = normalizeRole(message.role, toolCall);
    let text = extractPreviewText(message);
    if (!text) {
      const toolNames = extractToolNames(message);
      if (toolNames.length > 0) {
        const shown = toolNames.slice(0, 2);
        const overflow = toolNames.length - shown.length;
        text = `call ${shown.join(", ")}`;
        if (overflow > 0) {
          text += ` +${overflow}`;
        }
      }
    }
    if (!text) {
      text = extractMediaSummary(message);
    }
    if (!text) {
      continue;
    }
    let trimmed = text.trim();
    if (!trimmed) {
      continue;
    }
    if (role === "user") {
      trimmed = stripEnvelope(trimmed);
    }
    trimmed = truncatePreviewText(trimmed, maxChars);
    items.push({ role, text: trimmed });
  }

  if (items.length <= maxItems) {
    return items;
  }
  return items.slice(-maxItems);
}

function readRecentMessagesFromTranscript(
  filePath: string,
  maxMessages: number,
  readBytes: number,
): TranscriptPreviewMessage[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (size === 0) {
      return [];
    }

    const readStart = Math.max(0, size - readBytes);
    const readLen = Math.min(size, readBytes);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, readStart);

    const chunk = buf.toString("utf-8");
    const lines = chunk.split(/\r?\n/).filter((l) => l.trim());
    const tailLines = lines.slice(-PREVIEW_MAX_LINES);

    const collected: TranscriptPreviewMessage[] = [];
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const line = tailLines[i];
      try {
        const parsed = JSON.parse(line);
        const msg = parsed?.message as TranscriptPreviewMessage | undefined;
        if (msg && typeof msg === "object") {
          collected.push(msg);
          if (collected.length >= maxMessages) {
            break;
          }
        }
      } catch {
        // skip malformed lines
      }
    }
    return collected.toReversed();
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

export function readSessionPreviewItemsFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  agentId: string | undefined,
  maxItems: number,
  maxChars: number,
): SessionPreviewItem[] {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) {
    return [];
  }

  const boundedItems = Math.max(1, Math.min(maxItems, 50));
  const boundedChars = Math.max(20, Math.min(maxChars, 2000));

  for (const readSize of PREVIEW_READ_SIZES) {
    const messages = readRecentMessagesFromTranscript(filePath, boundedItems, readSize);
    if (messages.length > 0 || readSize === PREVIEW_READ_SIZES[PREVIEW_READ_SIZES.length - 1]) {
      return buildPreviewItems(messages, boundedItems, boundedChars);
    }
  }

  return [];
}
