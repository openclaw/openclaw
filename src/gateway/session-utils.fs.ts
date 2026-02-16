import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionPreviewItem } from "./session-utils.types.js";
import {
  resolveSessionFilePath,
  resolveSessionTranscriptPath,
  resolveSessionTranscriptPathInDir,
} from "../config/sessions.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import { extractToolCallNames, hasToolCall } from "../utils/transcript-tools.js";
import { stripEnvelope } from "./chat-sanitize.js";

type SessionTitleFields = {
  firstUserMessage: string | null;
  lastMessagePreview: string | null;
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

function getCachedSessionTitleFields(cacheKey: string, stat: fs.Stats): SessionTitleFields | null {
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

function setCachedSessionTitleFields(cacheKey: string, stat: fs.Stats, value: SessionTitleFields) {
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
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed?.message) {
        messages.push(parsed.message);
        continue;
      }

      // Compaction entries are not "message" records, but they're useful context for debugging.
      // Emit a lightweight synthetic message that the Web UI can render as a divider.
      if (parsed?.type === "compaction") {
        const ts = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
        const timestamp = Number.isFinite(ts) ? ts : Date.now();
        messages.push({
          role: "system",
          content: [{ type: "text", text: "Compaction" }],
          timestamp,
          __openclaw: {
            kind: "compaction",
            id: typeof parsed.id === "string" ? parsed.id : undefined,
          },
        });
      }
    } catch {
      // ignore bad lines
    }
  }
  return messages;
}

export function resolveSessionTranscriptCandidates(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string[] {
  const candidates: string[] = [];
  const pushCandidate = (resolve: () => string): void => {
    try {
      candidates.push(resolve());
    } catch {
      // Ignore invalid paths/IDs and keep scanning other safe candidates.
    }
  };

  if (storePath) {
    const sessionsDir = path.dirname(storePath);
    if (sessionFile) {
      pushCandidate(() =>
        resolveSessionFilePath(sessionId, { sessionFile }, { sessionsDir, agentId }),
      );
    }
    pushCandidate(() => resolveSessionTranscriptPathInDir(sessionId, sessionsDir));
  } else if (sessionFile) {
    if (agentId) {
      pushCandidate(() => resolveSessionFilePath(sessionId, { sessionFile }, { agentId }));
    } else {
      const trimmed = sessionFile.trim();
      if (trimmed) {
        candidates.push(path.resolve(trimmed));
      }
    }
  }

  if (agentId) {
    pushCandidate(() => resolveSessionTranscriptPath(sessionId, agentId));
  }

  const home = resolveRequiredHomeDir(process.env, os.homedir);
  const legacyDir = path.join(home, ".openclaw", "sessions");
  pushCandidate(() => resolveSessionTranscriptPathInDir(sessionId, legacyDir));

  return Array.from(new Set(candidates));
}

export type ArchiveFileReason = "bak" | "reset" | "deleted";

export function archiveFileOnDisk(filePath: string, reason: ArchiveFileReason): string {
  const ts = new Date().toISOString().replaceAll(":", "-");
  const archived = `${filePath}.${reason}.${ts}`;
  fs.renameSync(filePath, archived);
  return archived;
}

/**
 * Archives all transcript files for a given session.
 * Best-effort: silently skips files that don't exist or fail to rename.
 */
export function archiveSessionTranscripts(opts: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  reason: "reset" | "deleted";
}): string[] {
  const archived: string[] = [];
  for (const candidate of resolveSessionTranscriptCandidates(
    opts.sessionId,
    opts.storePath,
    opts.sessionFile,
    opts.agentId,
  )) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      archived.push(archiveFileOnDisk(candidate, opts.reason));
    } catch {
      // Best-effort.
    }
  }
  return archived;
}

function jsonUtf8Bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Buffer.byteLength(String(value), "utf8");
  }
}

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

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { firstUserMessage: null, lastMessagePreview: null };
  }

  const cacheKey = readSessionTitleFieldsCacheKey(filePath, opts);
  const cached = getCachedSessionTitleFields(cacheKey, stat);
  if (cached) {
    return cached;
  }

  if (stat.size === 0) {
    const empty = { firstUserMessage: null, lastMessagePreview: null };
    setCachedSessionTitleFields(cacheKey, stat, empty);
    return empty;
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
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

function extractTextFromContent(content: TranscriptMessage["content"]): string | null {
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  for (const part of content) {
    if (!part || typeof part.text !== "string") {
      continue;
    }
    if (part.type === "text" || part.type === "output_text" || part.type === "input_text") {
      const trimmed = part.text.trim();
      if (trimmed) {
        return trimmed;
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

export function readFirstUserMessageFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
  opts?: { includeInterSession?: boolean },
): string | null {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) {
    return null;
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const chunk = readTranscriptHeadChunk(fd);
    if (!chunk) {
      return null;
    }
    return extractFirstUserMessageFromTranscriptChunk(chunk, opts);
  } catch {
    // file read error
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
  return null;
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

export function readLastMessagePreviewFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string | null {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) {
    return null;
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (size === 0) {
      return null;
    }
    return readLastMessagePreviewFromOpenTranscript({ fd, size });
  } catch {
    // file error
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
  return null;
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
    const trimmed = message.content.trim();
    return trimmed ? trimmed : null;
  }
  if (Array.isArray(message.content)) {
    const parts = message.content
      .map((entry) => (typeof entry?.text === "string" ? entry.text : ""))
      .filter((text) => text.trim().length > 0);
    if (parts.length > 0) {
      return parts.join("\n").trim();
    }
  }
  if (typeof message.text === "string") {
    const trimmed = message.text.trim();
    return trimmed ? trimmed : null;
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
