import fs from "node:fs";
import path from "node:path";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type { SessionWriteLockAcquireTimeoutConfig } from "../../agents/session-write-lock.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { extractAssistantVisibleText } from "../../shared/chat-message-content.js";
import {
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
} from "./paths.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import { loadSessionStore, normalizeStoreSessionKey } from "./store.js";
import { parseSessionThreadInfo } from "./thread-info.js";
import { appendSessionTranscriptMessage } from "./transcript-append.js";
import { resolveMirroredTranscriptText } from "./transcript-mirror.js";
import type { SessionEntry } from "./types.js";

let piCodingAgentModulePromise: Promise<typeof import("@mariozechner/pi-coding-agent")> | null =
  null;

async function loadPiCodingAgentModule(): Promise<typeof import("@mariozechner/pi-coding-agent")> {
  piCodingAgentModulePromise ??= import("@mariozechner/pi-coding-agent");
  return await piCodingAgentModulePromise;
}

async function ensureSessionHeader(params: {
  sessionFile: string;
  sessionId: string;
}): Promise<void> {
  if (fs.existsSync(params.sessionFile)) {
    return;
  }
  const { CURRENT_SESSION_VERSION } = await loadPiCodingAgentModule();
  await fs.promises.mkdir(path.dirname(params.sessionFile), { recursive: true });
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  await fs.promises.writeFile(params.sessionFile, `${JSON.stringify(header)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export type SessionTranscriptAppendResult =
  | { ok: true; sessionFile: string; messageId: string }
  | { ok: false; reason: string };

export type SessionTranscriptUpdateMode = "inline" | "file-only" | "none";

export type SessionTranscriptAssistantMessage = Parameters<SessionManager["appendMessage"]>[0] & {
  role: "assistant";
};

type AssistantTranscriptText = {
  id?: string;
  text: string;
  timestamp?: number;
};

export type LatestAssistantTranscriptText = AssistantTranscriptText;
export type TailAssistantTranscriptText = AssistantTranscriptText;

const TRANSCRIPT_IDEMPOTENCY_INDEX_TYPE = "openclaw-transcript-idempotency-index";
const TRANSCRIPT_IDEMPOTENCY_INDEX_VERSION = 1;

type TranscriptIdempotencyIndexEntry = {
  messageId?: string;
};

type TranscriptIdempotencyIndex = {
  type: typeof TRANSCRIPT_IDEMPOTENCY_INDEX_TYPE;
  version: typeof TRANSCRIPT_IDEMPOTENCY_INDEX_VERSION;
  indexedBytes: number;
  keys: Record<string, TranscriptIdempotencyIndexEntry>;
};

type TranscriptIdempotencyLookup =
  | { status: "hit"; messageId: string | true }
  | { status: "miss" }
  | { status: "unavailable" };

function parseAssistantTranscriptText(line: string): AssistantTranscriptText | undefined {
  const parsed = JSON.parse(line) as {
    id?: unknown;
    message?: unknown;
  };
  const message = parsed.message as { role?: unknown; timestamp?: unknown } | undefined;
  if (!message || message.role !== "assistant") {
    return undefined;
  }
  const text = extractAssistantVisibleText(message)?.trim();
  if (!text) {
    return undefined;
  }
  return {
    ...(typeof parsed.id === "string" && parsed.id ? { id: parsed.id } : {}),
    text,
    ...(typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? { timestamp: message.timestamp }
      : {}),
  };
}

export async function resolveSessionTranscriptFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  agentId: string;
  threadId?: string | number;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry | undefined }> {
  const sessionPathOpts = resolveSessionFilePathOptions({
    agentId: params.agentId,
    storePath: params.storePath,
  });
  let sessionFile = resolveSessionFilePath(params.sessionId, params.sessionEntry, sessionPathOpts);
  let sessionEntry = params.sessionEntry;

  if (params.sessionStore && params.storePath) {
    const threadIdFromSessionKey = parseSessionThreadInfo(params.sessionKey).threadId;
    const fallbackSessionFile = !sessionEntry?.sessionFile
      ? resolveSessionTranscriptPath(
          params.sessionId,
          params.agentId,
          params.threadId ?? threadIdFromSessionKey,
        )
      : undefined;
    const resolvedSessionFile = await resolveAndPersistSessionFile({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
      sessionEntry,
      agentId: sessionPathOpts?.agentId,
      sessionsDir: sessionPathOpts?.sessionsDir,
      fallbackSessionFile,
    });
    sessionFile = resolvedSessionFile.sessionFile;
    sessionEntry = resolvedSessionFile.sessionEntry;
  }

  return {
    sessionFile,
    sessionEntry,
  };
}

export async function readLatestAssistantTextFromSessionTranscript(
  sessionFile: string | undefined,
): Promise<LatestAssistantTranscriptText | undefined> {
  if (!sessionFile?.trim()) {
    return undefined;
  }

  let raw: string;
  try {
    raw = await fs.promises.readFile(sessionFile, "utf-8");
  } catch {
    return undefined;
  }

  for (const line of raw.split(/\r?\n/).toReversed()) {
    if (!line.trim()) {
      continue;
    }
    try {
      const assistantText = parseAssistantTranscriptText(line);
      if (assistantText) {
        return assistantText;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function readTailAssistantTextFromSessionTranscript(
  sessionFile: string | undefined,
): Promise<TailAssistantTranscriptText | undefined> {
  if (!sessionFile?.trim()) {
    return undefined;
  }

  let raw: string;
  try {
    raw = await fs.promises.readFile(sessionFile, "utf-8");
  } catch {
    return undefined;
  }

  for (const line of raw.split(/\r?\n/).toReversed()) {
    if (!line.trim()) {
      continue;
    }
    try {
      return parseAssistantTranscriptText(line);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  text?: string;
  mediaUrls?: string[];
  idempotencyKey?: string;
  /** Optional override for store path (mostly for tests). */
  storePath?: string;
  updateMode?: SessionTranscriptUpdateMode;
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<SessionTranscriptAppendResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }

  const mirrorText = resolveMirroredTranscriptText({
    text: params.text,
    mediaUrls: params.mediaUrls,
  });
  if (!mirrorText) {
    return { ok: false, reason: "empty text" };
  }

  return appendExactAssistantMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey,
    storePath: params.storePath,
    idempotencyKey: params.idempotencyKey,
    updateMode: params.updateMode,
    config: params.config,
    message: {
      role: "assistant" as const,
      content: [{ type: "text", text: mirrorText }],
      api: "openai-responses",
      provider: "openclaw",
      model: "delivery-mirror",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    },
  });
}

export async function appendExactAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  message: SessionTranscriptAssistantMessage;
  idempotencyKey?: string;
  storePath?: string;
  updateMode?: SessionTranscriptUpdateMode;
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<SessionTranscriptAppendResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }
  if (params.message.role !== "assistant") {
    return { ok: false, reason: "message role must be assistant" };
  }

  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  const store = loadSessionStore(storePath, { skipCache: true });
  const normalizedKey = normalizeStoreSessionKey(sessionKey);
  const entry = (store[normalizedKey] ?? store[sessionKey]) as SessionEntry | undefined;
  if (!entry?.sessionId) {
    return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };
  }

  let sessionFile: string;
  try {
    const resolvedSessionFile = await resolveAndPersistSessionFile({
      sessionId: entry.sessionId,
      sessionKey,
      sessionStore: store,
      storePath,
      sessionEntry: entry,
      agentId: params.agentId,
      sessionsDir: path.dirname(storePath),
    });
    sessionFile = resolvedSessionFile.sessionFile;
  } catch (err) {
    return {
      ok: false,
      reason: formatErrorMessage(err),
    };
  }

  await ensureSessionHeader({ sessionFile, sessionId: entry.sessionId });

  const explicitIdempotencyKey =
    params.idempotencyKey ??
    ((params.message as { idempotencyKey?: unknown }).idempotencyKey as string | undefined);
  const existingMessageId = explicitIdempotencyKey
    ? await findTranscriptIdempotencyKey(sessionFile, explicitIdempotencyKey)
    : undefined;
  if (existingMessageId) {
    return {
      ok: true,
      sessionFile,
      messageId: existingMessageId === true ? (explicitIdempotencyKey ?? "") : existingMessageId,
    };
  }

  const latestEquivalentAssistantId = isRedundantDeliveryMirror(params.message)
    ? await findLatestEquivalentAssistantMessageId(sessionFile, params.message)
    : undefined;
  if (latestEquivalentAssistantId) {
    return { ok: true, sessionFile, messageId: latestEquivalentAssistantId };
  }

  const idempotencyIndexBaseBytes = explicitIdempotencyKey
    ? await getTranscriptFileSize(sessionFile)
    : undefined;
  const message = {
    ...params.message,
    ...(explicitIdempotencyKey ? { idempotencyKey: explicitIdempotencyKey } : {}),
  } as Parameters<SessionManager["appendMessage"]>[0];
  const { messageId } = await appendSessionTranscriptMessage({
    transcriptPath: sessionFile,
    message,
    config: params.config,
  });

  switch (params.updateMode ?? "inline") {
    case "inline":
      emitSessionTranscriptUpdate({ sessionFile, sessionKey, message, messageId });
      break;
    case "file-only":
      emitSessionTranscriptUpdate({ sessionFile, sessionKey });
      break;
    case "none":
      break;
  }
  if (explicitIdempotencyKey) {
    await recordTranscriptIdempotencyKey({
      transcriptPath: sessionFile,
      idempotencyKey: explicitIdempotencyKey,
      messageId,
      previousIndexedBytes: idempotencyIndexBaseBytes,
    });
  }
  return { ok: true, sessionFile, messageId };
}

function resolveTranscriptIdempotencyIndexPath(transcriptPath: string): string {
  return `${transcriptPath}.idempotency.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTranscriptIdempotencyIndex(raw: string): TranscriptIdempotencyIndex | undefined {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    return undefined;
  }
  if (
    parsed.type !== TRANSCRIPT_IDEMPOTENCY_INDEX_TYPE ||
    parsed.version !== TRANSCRIPT_IDEMPOTENCY_INDEX_VERSION ||
    typeof parsed.indexedBytes !== "number" ||
    !Number.isSafeInteger(parsed.indexedBytes) ||
    parsed.indexedBytes < 0 ||
    !isRecord(parsed.keys)
  ) {
    return undefined;
  }

  const keys: Record<string, TranscriptIdempotencyIndexEntry> = {};
  for (const [key, entry] of Object.entries(parsed.keys)) {
    if (!key || !isRecord(entry)) {
      return undefined;
    }
    if ("messageId" in entry && typeof entry.messageId !== "string") {
      return undefined;
    }
    keys[key] =
      typeof entry.messageId === "string" && entry.messageId ? { messageId: entry.messageId } : {};
  }

  return {
    type: TRANSCRIPT_IDEMPOTENCY_INDEX_TYPE,
    version: TRANSCRIPT_IDEMPOTENCY_INDEX_VERSION,
    indexedBytes: parsed.indexedBytes,
    keys,
  };
}

async function getTranscriptFileSize(transcriptPath: string): Promise<number | undefined> {
  try {
    return (await fs.promises.stat(transcriptPath)).size;
  } catch {
    return undefined;
  }
}

async function readTranscriptIdempotencyIndex(params: {
  transcriptPath: string;
  requireCurrentSize: boolean;
}): Promise<TranscriptIdempotencyIndex | undefined> {
  try {
    const [raw, stat] = await Promise.all([
      fs.promises.readFile(resolveTranscriptIdempotencyIndexPath(params.transcriptPath), "utf-8"),
      fs.promises.stat(params.transcriptPath),
    ]);
    const index = parseTranscriptIdempotencyIndex(raw);
    if (!index || index.indexedBytes > stat.size) {
      return undefined;
    }
    if (params.requireCurrentSize && index.indexedBytes !== stat.size) {
      return undefined;
    }
    return index;
  } catch {
    return undefined;
  }
}

async function writeTranscriptIdempotencyIndex(
  transcriptPath: string,
  index: TranscriptIdempotencyIndex,
): Promise<void> {
  await fs.promises.writeFile(
    resolveTranscriptIdempotencyIndexPath(transcriptPath),
    `${JSON.stringify(index)}\n`,
    { encoding: "utf-8", mode: 0o600 },
  );
}

async function readTranscriptIdempotencyIndexLookup(
  transcriptPath: string,
  idempotencyKey: string,
): Promise<TranscriptIdempotencyLookup> {
  const index = await readTranscriptIdempotencyIndex({ transcriptPath, requireCurrentSize: true });
  if (!index) {
    return { status: "unavailable" };
  }

  const entry = index.keys[idempotencyKey];
  if (entry) {
    return { status: "hit", messageId: entry.messageId ?? true };
  }

  const transcriptSize = await getTranscriptFileSize(transcriptPath);
  if (transcriptSize !== undefined && index.indexedBytes >= transcriptSize) {
    return { status: "miss" };
  }
  return { status: "unavailable" };
}

async function findTranscriptIdempotencyKey(
  transcriptPath: string,
  idempotencyKey: string,
): Promise<string | true | undefined> {
  const indexedLookup = await readTranscriptIdempotencyIndexLookup(transcriptPath, idempotencyKey);
  switch (indexedLookup.status) {
    case "hit":
      return indexedLookup.messageId;
    case "miss":
      return undefined;
    case "unavailable":
      return await scanTranscriptIdempotencyKey(transcriptPath, idempotencyKey);
  }
  return undefined;
}

async function scanTranscriptIdempotencyKey(
  transcriptPath: string,
  idempotencyKey: string,
): Promise<string | true | undefined> {
  const keys: Record<string, TranscriptIdempotencyIndexEntry> = {};
  let foundMessageId: string | true | undefined;
  let raw: string;
  try {
    raw = await fs.promises.readFile(transcriptPath, "utf-8");
  } catch {
    return undefined;
  }

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as {
        id?: unknown;
        message?: { idempotencyKey?: unknown };
      };
      const key = parsed.message?.idempotencyKey;
      if (typeof key !== "string" || !key) {
        continue;
      }
      const entry = typeof parsed.id === "string" && parsed.id ? { messageId: parsed.id } : {};
      keys[key] ??= entry;
      if (key === idempotencyKey && !foundMessageId) {
        foundMessageId = entry.messageId ?? true;
      }
    } catch {
      continue;
    }
  }

  await writeTranscriptIdempotencyIndex(transcriptPath, {
    type: TRANSCRIPT_IDEMPOTENCY_INDEX_TYPE,
    version: TRANSCRIPT_IDEMPOTENCY_INDEX_VERSION,
    indexedBytes: Buffer.byteLength(raw, "utf-8"),
    keys,
  }).catch(() => undefined);

  return foundMessageId;
}

async function recordTranscriptIdempotencyKey(params: {
  transcriptPath: string;
  idempotencyKey: string;
  messageId: string;
  previousIndexedBytes: number | undefined;
}): Promise<void> {
  if (params.previousIndexedBytes === undefined) {
    return;
  }

  const index = await readTranscriptIdempotencyIndex({
    transcriptPath: params.transcriptPath,
    requireCurrentSize: false,
  });
  if (!index || index.indexedBytes !== params.previousIndexedBytes) {
    return;
  }

  const transcriptSize = await getTranscriptFileSize(params.transcriptPath);
  if (transcriptSize === undefined || transcriptSize < index.indexedBytes) {
    return;
  }

  index.keys[params.idempotencyKey] = { messageId: params.messageId };
  index.indexedBytes = transcriptSize;
  await writeTranscriptIdempotencyIndex(params.transcriptPath, index).catch(() => undefined);
}

function isRedundantDeliveryMirror(message: SessionTranscriptAssistantMessage): boolean {
  return message.provider === "openclaw" && message.model === "delivery-mirror";
}

function extractAssistantMessageText(message: SessionTranscriptAssistantMessage): string | null {
  if (!Array.isArray(message.content)) {
    return null;
  }

  const parts = message.content
    .filter(
      (
        part,
      ): part is {
        type: "text";
        text: string;
      } => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0,
    )
    .map((part) => part.text.trim());

  return parts.length > 0 ? parts.join("\n").trim() : null;
}

async function findLatestEquivalentAssistantMessageId(
  transcriptPath: string,
  message: SessionTranscriptAssistantMessage,
): Promise<string | undefined> {
  const expectedText = extractAssistantMessageText(message);
  if (!expectedText) {
    return undefined;
  }

  try {
    const raw = await fs.promises.readFile(transcriptPath, "utf-8");
    const lines = raw.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as {
          id?: unknown;
          message?: SessionTranscriptAssistantMessage;
        };
        const candidate = parsed.message;
        if (!candidate || candidate.role !== "assistant") {
          continue;
        }
        const candidateText = extractAssistantMessageText(candidate);
        if (candidateText !== expectedText) {
          return undefined;
        }
        if (typeof parsed.id === "string" && parsed.id) {
          return parsed.id;
        }
        return undefined;
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}
