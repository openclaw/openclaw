import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionEntry } from "../config/sessions.js";
import { normalizeAssistantPhase } from "../shared/chat-message-content.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export const CODEX_CLI_PROVIDER = "codex-cli";
const CODEX_SESSIONS_RELATIVE_DIR = path.join(".codex", "sessions");
const codexCliSessionPathCache = new Map<string, string>();
const DEFAULT_MAX_CODEX_CLI_SESSION_PATH_CACHE_ENTRIES = 256;
let maxCodexCliSessionPathCacheEntries = DEFAULT_MAX_CODEX_CLI_SESSION_PATH_CACHE_ENTRIES;

type CodexCliTranscriptEntry = {
  timestamp?: unknown;
  type?: unknown;
  payload?: {
    type?: unknown;
    message?: unknown;
    phase?: unknown;
    images?: unknown;
    local_images?: unknown;
    text_elements?: unknown;
  };
};

type TranscriptContentBlock = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
};

type TranscriptLikeMessage = Record<string, unknown>;

function resolveHistoryHomeDir(homeDir?: string): string {
  return normalizeOptionalString(homeDir) || process.env.HOME || os.homedir();
}

function resolveCodexSessionsDir(homeDir?: string): string {
  return path.join(resolveHistoryHomeDir(homeDir), CODEX_SESSIONS_RELATIVE_DIR);
}

export function resolveCodexCliBindingSessionId(
  entry: SessionEntry | undefined,
): string | undefined {
  const bindingSessionId = normalizeOptionalString(
    entry?.cliSessionBindings?.[CODEX_CLI_PROVIDER]?.sessionId,
  );
  if (bindingSessionId) {
    return bindingSessionId;
  }
  const legacyMapSessionId = normalizeOptionalString(entry?.cliSessionIds?.[CODEX_CLI_PROVIDER]);
  return legacyMapSessionId || undefined;
}

function resolveTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isCodexCliHistoryFile(filePath: string, cliSessionId: string): boolean {
  return path.basename(filePath).endsWith(`${cliSessionId}.jsonl`);
}

function buildCodexCliSessionPathCacheKey(params: {
  sessionsDir: string;
  cliSessionId: string;
}): string {
  return `${params.sessionsDir}\t${params.cliSessionId}`;
}

function pruneCodexCliSessionPathCache(): void {
  while (codexCliSessionPathCache.size > maxCodexCliSessionPathCacheEntries) {
    const oldestKey = codexCliSessionPathCache.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    codexCliSessionPathCache.delete(oldestKey);
  }
}

function setCachedCodexCliSessionPath(cacheKey: string, filePath: string): void {
  codexCliSessionPathCache.delete(cacheKey);
  codexCliSessionPathCache.set(cacheKey, filePath);
  pruneCodexCliSessionPathCache();
}

function resolveCodexCliSessionFileCandidateMtime(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

function shouldReplaceCodexCliSessionFileCandidate(
  currentBest: { filePath: string; mtimeMs: number } | undefined,
  nextCandidate: { filePath: string; mtimeMs: number },
): boolean {
  if (!currentBest) {
    return true;
  }
  if (nextCandidate.mtimeMs !== currentBest.mtimeMs) {
    return nextCandidate.mtimeMs > currentBest.mtimeMs;
  }
  const nextName = path.basename(nextCandidate.filePath);
  const currentName = path.basename(currentBest.filePath);
  const fileNameCompare = nextName.localeCompare(currentName);
  if (fileNameCompare !== 0) {
    return fileNameCompare > 0;
  }
  return nextCandidate.filePath.localeCompare(currentBest.filePath) > 0;
}

function findCodexCliSessionFile(params: {
  sessionsDir: string;
  cliSessionId: string;
}): string | undefined {
  const cacheKey = buildCodexCliSessionPathCacheKey(params);
  const cached = codexCliSessionPathCache.get(cacheKey);
  if (cached && fs.existsSync(cached)) {
    setCachedCodexCliSessionPath(cacheKey, cached);
    return cached;
  }
  if (cached) {
    codexCliSessionPathCache.delete(cacheKey);
  }
  if (!fs.existsSync(params.sessionsDir)) {
    return undefined;
  }

  const stack = [params.sessionsDir];
  let bestMatch: { filePath: string; mtimeMs: number } | undefined;
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const filePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
        continue;
      }
      if (!entry.isFile() || !isCodexCliHistoryFile(filePath, params.cliSessionId)) {
        continue;
      }
      const candidate = {
        filePath,
        mtimeMs: resolveCodexCliSessionFileCandidateMtime(filePath),
      };
      if (shouldReplaceCodexCliSessionFileCandidate(bestMatch, candidate)) {
        bestMatch = candidate;
      }
    }
  }
  if (!bestMatch) {
    return undefined;
  }
  setCachedCodexCliSessionPath(cacheKey, bestMatch.filePath);
  return bestMatch.filePath;
}

export function resolveCodexCliSessionFilePath(params: {
  cliSessionId: string;
  homeDir?: string;
}): string | undefined {
  return findCodexCliSessionFile({
    sessionsDir: resolveCodexSessionsDir(params.homeDir),
    cliSessionId: params.cliSessionId,
  });
}

function buildImportedMessageMeta(params: {
  cliSessionId: string;
  externalId: string;
  phase?: string;
}) {
  return {
    importedFrom: CODEX_CLI_PROVIDER,
    cliSessionId: params.cliSessionId,
    externalId: params.externalId,
    ...(params.phase ? { phase: params.phase } : {}),
  };
}

function buildTextBlock(text: string): TranscriptContentBlock {
  return {
    type: "text",
    text,
  };
}

function appendUniqueTextBlock(blocks: TranscriptContentBlock[], value: unknown): void {
  const text = normalizeOptionalString(value);
  if (!text) {
    return;
  }
  if (blocks.some((block) => block.type === "text" && block.text === text)) {
    return;
  }
  blocks.push(buildTextBlock(text));
}

function resolveCodexCliTextElementText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeOptionalString(value);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as {
    text?: unknown;
    content?: unknown;
    message?: unknown;
    value?: unknown;
  };
  return (
    normalizeOptionalString(record.text) ??
    normalizeOptionalString(record.content) ??
    normalizeOptionalString(record.message) ??
    normalizeOptionalString(record.value)
  );
}

function parseDataUriImage(value: string): TranscriptContentBlock | null {
  const trimmed = value.trim();
  const match = /^data:([^;,]+);base64,(.+)$/iu.exec(trimmed);
  if (!match) {
    return null;
  }
  const [, mimeType, data] = match;
  return {
    type: "image",
    mimeType,
    data,
  };
}

function resolveCodexCliInlineImage(value: unknown): TranscriptContentBlock | null {
  if (typeof value === "string") {
    return parseDataUriImage(value);
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as {
    data?: unknown;
    base64?: unknown;
    image?: unknown;
    mimeType?: unknown;
    mediaType?: unknown;
    media_type?: unknown;
    contentType?: unknown;
    content_type?: unknown;
  };
  const mimeType =
    normalizeOptionalString(record.mimeType) ??
    normalizeOptionalString(record.mediaType) ??
    normalizeOptionalString(record.media_type) ??
    normalizeOptionalString(record.contentType) ??
    normalizeOptionalString(record.content_type);
  const directData = normalizeOptionalString(record.data) ?? normalizeOptionalString(record.base64);
  if (mimeType && directData) {
    return {
      type: "image",
      mimeType,
      data: directData,
    };
  }
  if (typeof record.image === "string") {
    const parsedDataUri = parseDataUriImage(record.image);
    if (parsedDataUri) {
      return parsedDataUri;
    }
    if (mimeType) {
      return {
        type: "image",
        mimeType,
        data: record.image,
      };
    }
  }
  return null;
}

function resolveCodexCliAttachmentLabel(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = normalizeOptionalString(value);
    if (!normalized) {
      return undefined;
    }
    return path.basename(normalized) || normalized;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as {
    label?: unknown;
    name?: unknown;
    fileName?: unknown;
    filename?: unknown;
    path?: unknown;
    uri?: unknown;
    url?: unknown;
  };
  const normalized =
    normalizeOptionalString(record.label) ??
    normalizeOptionalString(record.name) ??
    normalizeOptionalString(record.fileName) ??
    normalizeOptionalString(record.filename) ??
    normalizeOptionalString(record.path) ??
    normalizeOptionalString(record.uri) ??
    normalizeOptionalString(record.url);
  if (!normalized) {
    return undefined;
  }
  return path.basename(normalized) || normalized;
}

function appendCodexCliAttachmentBlocks(params: {
  blocks: TranscriptContentBlock[];
  attachments: unknown;
  placeholderPrefix: string;
}): void {
  if (!Array.isArray(params.attachments)) {
    return;
  }
  for (const attachment of params.attachments) {
    const inlineImage = resolveCodexCliInlineImage(attachment);
    if (inlineImage) {
      params.blocks.push(inlineImage);
      continue;
    }
    const label = resolveCodexCliAttachmentLabel(attachment);
    if (label) {
      params.blocks.push(buildTextBlock(`[${params.placeholderPrefix}: ${label}]`));
    }
  }
}

function buildCodexCliUserContent(
  payload: CodexCliTranscriptEntry["payload"],
): string | TranscriptContentBlock[] | undefined {
  const blocks: TranscriptContentBlock[] = [];
  appendUniqueTextBlock(blocks, payload?.message);
  if (Array.isArray(payload?.text_elements)) {
    for (const textElement of payload.text_elements) {
      appendUniqueTextBlock(blocks, resolveCodexCliTextElementText(textElement));
    }
  }
  appendCodexCliAttachmentBlocks({
    blocks,
    attachments: payload?.images,
    placeholderPrefix: "Image attachment",
  });
  appendCodexCliAttachmentBlocks({
    blocks,
    attachments: payload?.local_images,
    placeholderPrefix: "Local image attachment",
  });
  if (blocks.length === 0) {
    return undefined;
  }
  if (blocks.length === 1 && blocks[0]?.type === "text" && typeof blocks[0].text === "string") {
    return blocks[0].text;
  }
  return blocks;
}

function parseCodexCliHistoryEntry(
  entry: CodexCliTranscriptEntry,
  cliSessionId: string,
  sequence: number,
): TranscriptLikeMessage | null {
  if (entry.type !== "event_msg" || !entry.payload || typeof entry.payload !== "object") {
    return null;
  }
  const payloadType = normalizeOptionalString(entry.payload.type);
  if (!payloadType) {
    return null;
  }
  const timestamp = resolveTimestampMs(entry.timestamp);
  const phase = normalizeOptionalString(entry.payload.phase);
  const externalId = `${payloadType}:${normalizeOptionalString(entry.timestamp) ?? "no-ts"}:${sequence}`;

  if (payloadType === "user_message") {
    const content = buildCodexCliUserContent(entry.payload);
    if (content === undefined) {
      return null;
    }
    return {
      role: "user",
      content,
      ...(timestamp !== undefined ? { timestamp } : {}),
      __openclaw: buildImportedMessageMeta({ cliSessionId, externalId }),
    };
  }

  if (payloadType === "agent_message") {
    const message = normalizeOptionalString(entry.payload.message);
    if (!message) {
      return null;
    }
    const normalizedPhase = normalizeAssistantPhase(phase);
    return {
      role: "assistant",
      provider: CODEX_CLI_PROVIDER,
      content: [{ type: "text", text: message }],
      ...(normalizedPhase ? { phase: normalizedPhase } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
      __openclaw: buildImportedMessageMeta({ cliSessionId, externalId, phase }),
    };
  }

  return null;
}

export function readCodexCliSessionMessages(params: {
  cliSessionId: string;
  homeDir?: string;
}): unknown[] {
  const filePath = resolveCodexCliSessionFilePath(params);
  if (!filePath) {
    return [];
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split(/\r?\n/);
  const messages: TranscriptLikeMessage[] = [];
  let sequence = 0;
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as CodexCliTranscriptEntry;
      const parsed = parseCodexCliHistoryEntry(entry, params.cliSessionId, sequence);
      if (parsed) {
        messages.push(parsed);
        sequence += 1;
      }
    } catch {
      // Ignore malformed Codex history lines and keep the usable transcript.
    }
  }
  return messages;
}

export const __testing = {
  get codexCliSessionPathCacheSize(): number {
    return codexCliSessionPathCache.size;
  },
  get maxCodexCliSessionPathCacheEntries(): number {
    return maxCodexCliSessionPathCacheEntries;
  },
  resetCodexCliSessionPathCacheForTests(): void {
    codexCliSessionPathCache.clear();
    maxCodexCliSessionPathCacheEntries = DEFAULT_MAX_CODEX_CLI_SESSION_PATH_CACHE_ENTRIES;
  },
  setMaxCodexCliSessionPathCacheEntriesForTests(limit: number): void {
    if (!Number.isFinite(limit)) {
      return;
    }
    maxCodexCliSessionPathCacheEntries = Math.max(1, Math.trunc(limit));
    pruneCodexCliSessionPathCache();
  },
};
