import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeProviderId } from "../agents/model-selection.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import type { SessionEntry } from "../config/sessions.js";
import { attachOpenClawTranscriptMeta } from "./session-utils.fs.js";

const CLAUDE_CLI_PROVIDER = "claude-cli";
const CLAUDE_PROJECTS_RELATIVE_DIR = path.join(".claude", "projects");
const DEDUPE_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

type ClaudeCliProjectEntry = {
  type?: unknown;
  timestamp?: unknown;
  uuid?: unknown;
  isSidechain?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    model?: unknown;
    stop_reason?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
    };
  };
};

type TranscriptLikeMessage = Record<string, unknown>;

function resolveHistoryHomeDir(homeDir?: string): string {
  return homeDir?.trim() || process.env.HOME || os.homedir();
}

function resolveClaudeProjectsDir(homeDir?: string): string {
  return path.join(resolveHistoryHomeDir(homeDir), CLAUDE_PROJECTS_RELATIVE_DIR);
}

function resolveClaudeCliBindingSessionId(entry: SessionEntry | undefined): string | undefined {
  const bindingSessionId = entry?.cliSessionBindings?.[CLAUDE_CLI_PROVIDER]?.sessionId?.trim();
  if (bindingSessionId) {
    return bindingSessionId;
  }
  const legacyMapSessionId = entry?.cliSessionIds?.[CLAUDE_CLI_PROVIDER]?.trim();
  if (legacyMapSessionId) {
    return legacyMapSessionId;
  }
  const legacyClaudeSessionId = entry?.claudeCliSessionId?.trim();
  return legacyClaudeSessionId || undefined;
}

function resolveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveClaudeCliUsage(raw: ClaudeCliProjectEntry["message"]["usage"]) {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const input = resolveFiniteNumber(raw.input_tokens);
  const output = resolveFiniteNumber(raw.output_tokens);
  const cacheRead = resolveFiniteNumber(raw.cache_read_input_tokens);
  const cacheWrite = resolveFiniteNumber(raw.cache_creation_input_tokens);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function extractComparableText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as { role?: unknown; text?: unknown; content?: unknown };
  const role = typeof record.role === "string" ? record.role : undefined;
  const parts: string[] = [];
  if (typeof record.text === "string") {
    parts.push(record.text);
  }
  if (typeof record.content === "string") {
    parts.push(record.content);
  } else if (Array.isArray(record.content)) {
    for (const block of record.content) {
      if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  const joined = parts.join("\n").trim();
  if (!joined) {
    return undefined;
  }
  const visible = role === "user" ? stripInboundMetadata(joined) : joined;
  const normalized = visible.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function resolveComparableTimestamp(message: unknown): number | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  return resolveFiniteNumber((message as { timestamp?: unknown }).timestamp);
}

function resolveComparableRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function resolveImportedExternalId(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const meta =
    "__openclaw" in message &&
    (message as { __openclaw?: unknown }).__openclaw &&
    typeof (message as { __openclaw?: unknown }).__openclaw === "object"
      ? ((message as { __openclaw?: Record<string, unknown> }).__openclaw ?? {})
      : undefined;
  const externalId = meta?.externalId;
  return typeof externalId === "string" && externalId.trim() ? externalId : undefined;
}

function isEquivalentImportedMessage(existing: unknown, imported: unknown): boolean {
  const importedExternalId = resolveImportedExternalId(imported);
  if (importedExternalId && resolveImportedExternalId(existing) === importedExternalId) {
    return true;
  }

  const existingRole = resolveComparableRole(existing);
  const importedRole = resolveComparableRole(imported);
  if (!existingRole || existingRole !== importedRole) {
    return false;
  }

  const existingText = extractComparableText(existing);
  const importedText = extractComparableText(imported);
  if (!existingText || !importedText || existingText !== importedText) {
    return false;
  }

  const existingTimestamp = resolveComparableTimestamp(existing);
  const importedTimestamp = resolveComparableTimestamp(imported);
  if (existingTimestamp === undefined || importedTimestamp === undefined) {
    return true;
  }

  return Math.abs(existingTimestamp - importedTimestamp) <= DEDUPE_TIMESTAMP_WINDOW_MS;
}

function compareHistoryMessages(
  a: { message: unknown; order: number },
  b: { message: unknown; order: number },
): number {
  const aTimestamp = resolveComparableTimestamp(a.message);
  const bTimestamp = resolveComparableTimestamp(b.message);
  if (aTimestamp !== undefined && bTimestamp !== undefined && aTimestamp !== bTimestamp) {
    return aTimestamp - bTimestamp;
  }
  if (aTimestamp !== undefined && bTimestamp === undefined) {
    return -1;
  }
  if (aTimestamp === undefined && bTimestamp !== undefined) {
    return 1;
  }
  return a.order - b.order;
}

function parseClaudeCliHistoryEntry(
  entry: ClaudeCliProjectEntry,
  cliSessionId: string,
): TranscriptLikeMessage | null {
  if (entry.isSidechain === true || !entry.message || typeof entry.message !== "object") {
    return null;
  }
  const type = typeof entry.type === "string" ? entry.type : undefined;
  const role = typeof entry.message.role === "string" ? entry.message.role : undefined;
  if (type !== "user" && type !== "assistant") {
    return null;
  }
  if (role !== type) {
    return null;
  }

  const timestamp = resolveTimestampMs(entry.timestamp);
  const baseMeta = {
    importedFrom: CLAUDE_CLI_PROVIDER,
    cliSessionId,
    ...(typeof entry.uuid === "string" && entry.uuid.trim() ? { externalId: entry.uuid } : {}),
  };

  if (type === "user") {
    const content =
      typeof entry.message.content === "string" || Array.isArray(entry.message.content)
        ? cloneJsonValue(entry.message.content)
        : undefined;
    if (content === undefined) {
      return null;
    }
    return attachOpenClawTranscriptMeta(
      {
        role: "user",
        content,
        ...(timestamp !== undefined ? { timestamp } : {}),
      },
      baseMeta,
    ) as TranscriptLikeMessage;
  }

  const content =
    typeof entry.message.content === "string" || Array.isArray(entry.message.content)
      ? cloneJsonValue(entry.message.content)
      : undefined;
  if (content === undefined) {
    return null;
  }
  return attachOpenClawTranscriptMeta(
    {
      role: "assistant",
      content,
      api: "anthropic-messages",
      provider: CLAUDE_CLI_PROVIDER,
      ...(typeof entry.message.model === "string" && entry.message.model.trim()
        ? { model: entry.message.model }
        : {}),
      ...(typeof entry.message.stop_reason === "string" && entry.message.stop_reason.trim()
        ? { stopReason: entry.message.stop_reason }
        : {}),
      ...(resolveClaudeCliUsage(entry.message.usage)
        ? { usage: resolveClaudeCliUsage(entry.message.usage) }
        : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    },
    baseMeta,
  ) as TranscriptLikeMessage;
}

export function resolveClaudeCliSessionFilePath(params: {
  cliSessionId: string;
  homeDir?: string;
}): string | undefined {
  const projectsDir = resolveClaudeProjectsDir(params.homeDir);
  let projectEntries: fs.Dirent[];
  try {
    projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of projectEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(projectsDir, entry.name, `${params.cliSessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function readClaudeCliSessionMessages(params: {
  cliSessionId: string;
  homeDir?: string;
}): TranscriptLikeMessage[] {
  const filePath = resolveClaudeCliSessionFilePath(params);
  if (!filePath) {
    return [];
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const messages: TranscriptLikeMessage[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as ClaudeCliProjectEntry;
      const message = parseClaudeCliHistoryEntry(parsed, params.cliSessionId);
      if (message) {
        messages.push(message);
      }
    } catch {
      // Ignore malformed external history entries.
    }
  }
  return messages;
}

export function mergeImportedChatHistoryMessages(params: {
  localMessages: unknown[];
  importedMessages: unknown[];
}): unknown[] {
  if (params.importedMessages.length === 0) {
    return params.localMessages;
  }
  const merged = params.localMessages.map((message, index) => ({ message, order: index }));
  let nextOrder = merged.length;
  for (const imported of params.importedMessages) {
    if (merged.some((existing) => isEquivalentImportedMessage(existing.message, imported))) {
      continue;
    }
    merged.push({ message: imported, order: nextOrder });
    nextOrder += 1;
  }
  merged.sort(compareHistoryMessages);
  return merged.map((entry) => entry.message);
}

export function augmentChatHistoryWithCliSessionImports(params: {
  entry: SessionEntry | undefined;
  provider?: string;
  localMessages: unknown[];
  homeDir?: string;
}): unknown[] {
  const cliSessionId = resolveClaudeCliBindingSessionId(params.entry);
  if (!cliSessionId) {
    return params.localMessages;
  }

  const normalizedProvider = normalizeProviderId(params.provider ?? "");
  if (
    normalizedProvider &&
    normalizedProvider !== CLAUDE_CLI_PROVIDER &&
    params.localMessages.length > 0
  ) {
    return params.localMessages;
  }

  const importedMessages = readClaudeCliSessionMessages({
    cliSessionId,
    homeDir: params.homeDir,
  });
  return mergeImportedChatHistoryMessages({
    localMessages: params.localMessages,
    importedMessages,
  });
}
