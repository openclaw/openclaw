import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionPreviewItem } from "./session-utils.types.js";
import { isCliProvider } from "../agents/model-selection.js";
import { deriveCliContextTokens, type NormalizedUsage } from "../agents/usage.js";
import { resolveSessionTranscriptPath } from "../config/sessions.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { extractToolCallNames, hasToolCall } from "../utils/transcript-tools.js";
import { stripEnvelope } from "./chat-sanitize.js";

export type TranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

/**
 * In-process lock for session transcript writes.
 * Ensures atomic user+assistant message pairs within the same Node process.
 * Similar protection to what SessionManager provides for Pi agents.
 */
const sessionWriteLocks = new Map<string, Promise<void>>();

async function withSessionLock<T>(sessionId: string, fn: () => T | Promise<T>): Promise<T> {
  // Wait for any pending write to this session
  const pending = sessionWriteLocks.get(sessionId);
  if (pending) {
    await pending.catch(() => {}); // Ignore errors from previous writes
  }

  // Create a new lock for this write
  let resolve: () => void;
  const lock = new Promise<void>((r) => {
    resolve = r;
  });
  sessionWriteLocks.set(sessionId, lock);

  try {
    return await fn();
  } finally {
    resolve!();
    // Clean up if this is still our lock
    if (sessionWriteLocks.get(sessionId) === lock) {
      sessionWriteLocks.delete(sessionId);
    }
  }
}

/**
 * Ensures a transcript file exists with a valid session header.
 * Creates the file and parent directories if needed.
 * Uses atomic file creation (flag: 'wx') to prevent TOCTOU race conditions.
 * Exported for reuse by other modules (e.g., server-methods/chat.ts).
 */
export function ensureTranscriptFile(params: { transcriptPath: string; sessionId: string }): {
  ok: boolean;
  error?: string;
} {
  try {
    fs.mkdirSync(path.dirname(params.transcriptPath), { recursive: true });
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    // Use 'wx' flag for atomic creation - fails if file exists (prevents TOCTOU race)
    fs.writeFileSync(params.transcriptPath, `${JSON.stringify(header)}\n`, {
      encoding: "utf-8",
      flag: "wx",
    });
    return { ok: true };
  } catch (err) {
    // EEXIST means file was created by another process - that's fine
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { ok: true };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Resolves transcript path from params.
 * @param params.sessionFile - Direct path to transcript file (preferred)
 * @param params.storePath - Fallback: derives transcript path from store location
 * @returns Transcript path or null if neither sessionFile nor storePath provided
 */
function resolveTranscriptPathFromParams(params: {
  sessionId: string;
  sessionFile?: string;
  storePath?: string;
}): string | null {
  if (params.sessionFile) {
    return params.sessionFile;
  }
  if (params.storePath) {
    return path.join(path.dirname(params.storePath), `${params.sessionId}.jsonl`);
  }
  return null;
}

/**
 * Internal implementation of message append (no locking).
 */
function appendMessageToTranscriptImpl(
  params: {
    message: string;
    role: "user" | "assistant";
    sessionId: string;
    sessionFile?: string;
    storePath?: string;
    createIfMissing?: boolean;
    stopReason?: string;
    provider?: string;
    model?: string;
    /** Token usage for assistant messages (CLI backends). */
    usage?: NormalizedUsage;
  },
  transcriptPath: string,
): TranscriptAppendResult {
  if (!fs.existsSync(transcriptPath)) {
    if (!params.createIfMissing) {
      return { ok: false, error: "transcript file not found" };
    }
    const ensured = ensureTranscriptFile({
      transcriptPath,
      sessionId: params.sessionId,
    });
    if (!ensured.ok) {
      return { ok: false, error: ensured.error ?? "failed to create transcript file" };
    }
  }

  const now = Date.now();
  const messageId = crypto.randomUUID().slice(0, 8);
  const messageBody: Record<string, unknown> = {
    role: params.role,
    content: [{ type: "text", text: params.message }],
    timestamp: now,
  };
  if (params.role === "assistant") {
    messageBody.stopReason = params.stopReason ?? "cli_backend";
    const u = params.usage;
    // For CLI providers, use CLI-specific calculation (cacheRead + cacheWrite + input)
    // representing the full context for this turn
    const isCli = isCliProvider(params.provider ?? "", undefined);
    const derivedTotal = isCli
      ? (deriveCliContextTokens(u) ?? 0)
      : (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
    const usageToWrite = {
      input: u?.input ?? 0,
      output: u?.output ?? 0,
      cacheRead: u?.cacheRead,
      cacheWrite: u?.cacheWrite,
      totalTokens:
        u?.total ?? (derivedTotal > 0 ? derivedTotal : (u?.input ?? 0) + (u?.output ?? 0)),
    };
    messageBody.usage = usageToWrite;
    if (params.provider) {
      messageBody.provider = params.provider;
    }
    if (params.model) {
      messageBody.model = params.model;
    }
  }
  const transcriptEntry = {
    type: "message",
    id: messageId,
    timestamp: new Date(now).toISOString(),
    message: messageBody,
  };

  try {
    fs.appendFileSync(transcriptPath, `${JSON.stringify(transcriptEntry)}\n`, "utf-8");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return { ok: true, messageId };
}

/**
 * Appends a message to a session transcript file.
 * Used for CLI backend responses which bypass SessionManager.
 *
 * Note: This is a synchronous function. For concurrent-safe writes
 * (e.g., multiple CLI runs on same session), use appendMessageToTranscriptAsync().
 */
export function appendMessageToTranscript(params: {
  message: string;
  role: "user" | "assistant";
  sessionId: string;
  sessionFile?: string;
  storePath?: string;
  createIfMissing?: boolean;
  stopReason?: string;
  /** Provider that generated the response (for assistant messages). */
  provider?: string;
  /** Model that generated the response (for assistant messages). */
  model?: string;
  /** Token usage for assistant messages (CLI backends). */
  usage?: NormalizedUsage;
}): TranscriptAppendResult {
  const transcriptPath = resolveTranscriptPathFromParams(params);
  if (!transcriptPath) {
    return { ok: false, error: "transcript path not resolved" };
  }
  return appendMessageToTranscriptImpl(params, transcriptPath);
}

/**
 * Async version of appendMessageToTranscript with session-level locking.
 * Ensures atomic writes when multiple concurrent writes target the same session.
 * Provides similar protection to what SessionManager offers for Pi agents.
 */
export async function appendMessageToTranscriptAsync(params: {
  message: string;
  role: "user" | "assistant";
  sessionId: string;
  sessionFile?: string;
  storePath?: string;
  createIfMissing?: boolean;
  stopReason?: string;
  provider?: string;
  model?: string;
  /** Token usage for assistant messages (CLI backends). */
  usage?: NormalizedUsage;
}): Promise<TranscriptAppendResult> {
  const transcriptPath = resolveTranscriptPathFromParams(params);
  if (!transcriptPath) {
    return { ok: false, error: "transcript path not resolved" };
  }
  return withSessionLock(params.sessionId, () =>
    appendMessageToTranscriptImpl(params, transcriptPath),
  );
}

/**
 * Appends an assistant message to a session transcript file.
 * Used for CLI backend responses which bypass SessionManager.
 */
export function appendAssistantMessageToTranscript(params: {
  message: string;
  sessionId: string;
  sessionFile?: string;
  storePath?: string;
  createIfMissing?: boolean;
  /** Provider that generated the response. */
  provider?: string;
  /** Model that generated the response. */
  model?: string;
  /** Token usage for assistant messages (CLI backends). */
  usage?: NormalizedUsage;
}): TranscriptAppendResult {
  return appendMessageToTranscript({
    ...params,
    role: "assistant",
  });
}

/**
 * Async version with session-level locking for concurrent-safe writes.
 */
export async function appendAssistantMessageToTranscriptAsync(params: {
  message: string;
  sessionId: string;
  sessionFile?: string;
  storePath?: string;
  createIfMissing?: boolean;
  provider?: string;
  model?: string;
  /** Token usage for assistant messages (CLI backends). */
  usage?: NormalizedUsage;
}): Promise<TranscriptAppendResult> {
  return appendMessageToTranscriptAsync({
    ...params,
    role: "assistant",
  });
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
  if (sessionFile) {
    candidates.push(sessionFile);
  }
  if (storePath) {
    const dir = path.dirname(storePath);
    candidates.push(path.join(dir, `${sessionId}.jsonl`));
  }
  if (agentId) {
    candidates.push(resolveSessionTranscriptPath(sessionId, agentId));
  }
  const home = resolveRequiredHomeDir(process.env, os.homedir);
  candidates.push(path.join(home, ".openclaw", "sessions", `${sessionId}.jsonl`));
  return candidates;
}

export function archiveFileOnDisk(filePath: string, reason: string): string {
  const ts = new Date().toISOString().replaceAll(":", "-");
  const archived = `${filePath}.${reason}.${ts}`;
  fs.renameSync(filePath, archived);
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
};

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

export function readFirstUserMessageFromTranscript(
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
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead === 0) {
      return null;
    }
    const chunk = buf.toString("utf-8", 0, bytesRead);
    const lines = chunk.split(/\r?\n/).slice(0, MAX_LINES_TO_SCAN);

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        const msg = parsed?.message as TranscriptMessage | undefined;
        if (msg?.role === "user") {
          const text = extractTextFromContent(msg.content);
          if (text) {
            return text;
          }
        }
      } catch {
        // skip malformed lines
      }
    }
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

    const readStart = Math.max(0, size - LAST_MSG_MAX_BYTES);
    const readLen = Math.min(size, LAST_MSG_MAX_BYTES);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, readStart);

    const chunk = buf.toString("utf-8");
    const lines = chunk.split(/\r?\n/).filter((l) => l.trim());
    const tailLines = lines.slice(-LAST_MSG_MAX_LINES);

    for (let i = tailLines.length - 1; i >= 0; i--) {
      const line = tailLines[i];
      try {
        const parsed = JSON.parse(line);
        const msg = parsed?.message as TranscriptMessage | undefined;
        if (msg?.role === "user" || msg?.role === "assistant") {
          const text = extractTextFromContent(msg.content);
          if (text) {
            return text;
          }
        }
      } catch {
        // skip malformed
      }
    }
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
