import fs from "node:fs/promises";
import path from "node:path";
import type { SessionEntry } from "../config/sessions/types.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../agents/workspace.js";
import { resolveSessionFilePath } from "../config/sessions/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hashText } from "./internal.js";

const log = createSubsystemLogger("memory");

const DEFAULT_EXCERPT_MESSAGES = 12;
const MAX_EXCERPT_CHARS = 2000;

const SIGNAL_RULES: Array<{ label: string; regex: RegExp }> = [
  {
    label: "deploy",
    regex: /\b(deploy|deployment|release|rollback|despleg|produccion|production|prod|staging)\b/i,
  },
  { label: "incident", regex: /\b(incident|outage|downtime|sev|pager|on-call|caida)\b/i },
  {
    label: "error",
    regex: /\b(error|exception|stack trace|crash|failed|failure|timeout|fallo|crash)\b/i,
  },
  { label: "fix", regex: /\b(fix|bug|issue|hotfix|patch|arregl|corrig|correg|soluciona)\b/i },
  { label: "git", regex: /\b(commit|branch|merge|pull request|pr\b|push|cherry-pick)\b/i },
  { label: "tests", regex: /\b(test|lint|ci\b|build|pipeline|prueba|tests)\b/i },
  { label: "config", regex: /\b(config|env|secret|token|credential|secreto|credencial)\b/i },
  { label: "api", regex: /\b(api|endpoint|route|request|response|ruta|http)\b/i },
  {
    label: "db",
    regex: /\b(db|database|postgres|mysql|redis|schema|migration|query|base de datos|bd)\b/i,
  },
  {
    label: "code",
    regex: /```|`[^`]+`|\b(const|let|function|class|import|export|SELECT|UPDATE|INSERT|DELETE)\b/i,
  },
];

type TranscriptMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
};

export type ParsedTranscript = {
  messages: TranscriptMessage[];
  startedAt?: string;
  lastMessageAt?: string;
};

export type ConversationMemoryEntry = {
  entity_type: "ConversationMemory";
  id: string;
  hash: string;
  timestamp: string;
  session_id: string;
  session_key?: string;
  agent_id?: string;
  event_action?: string;
  source?: string;
  message_count: number;
  user_messages: number;
  assistant_messages: number;
  total_chars: number;
  excerpt: string;
  signals: string[];
  started_at?: string;
  last_message_at?: string;
  channel?: string;
  thread_id?: string | number;
  account_id?: string;
  subject?: string;
};

const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();

const extractTextFromContent = (
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string | null => {
  if (typeof content === "string") {
    const trimmed = normalizeText(content);
    return trimmed ? trimmed : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part.text !== "string") {
      continue;
    }
    if (part.type && !["text", "input_text", "output_text"].includes(part.type)) {
      continue;
    }
    const trimmed = normalizeText(part.text);
    if (trimmed) {
      parts.push(trimmed);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" ");
};

const coerceTimestamp = (value: unknown): number | undefined => {
  if (typeof value === "number" && !Number.isNaN(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

export function parseTranscript(raw: string): ParsedTranscript {
  const messages: TranscriptMessage[] = [];
  let startedAt: string | undefined;
  let lastMessageAt: string | undefined;

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") {
      continue;
    }
    const recordData = record as { type?: unknown; timestamp?: unknown; message?: unknown };
    if (recordData.type === "session") {
      const startedAtMs = coerceTimestamp(recordData.timestamp);
      if (typeof startedAtMs === "number") {
        startedAt = new Date(startedAtMs).toISOString();
      } else if (typeof recordData.timestamp === "string") {
        startedAt = recordData.timestamp;
      }
      continue;
    }
    if (recordData.type !== "message") {
      continue;
    }
    if (!recordData.message || typeof recordData.message !== "object") {
      continue;
    }
    const message = recordData.message as {
      role?: unknown;
      content?: unknown;
      timestamp?: unknown;
    };
    if (typeof message.role !== "string") {
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const text = extractTextFromContent(
      message.content as string | Array<{ type?: string; text?: string }> | undefined,
    );
    if (!text || text.startsWith("/")) {
      continue;
    }
    const tsRaw = message.timestamp ?? recordData.timestamp;
    const timestamp = coerceTimestamp(tsRaw);
    if (typeof timestamp === "number") {
      lastMessageAt = new Date(timestamp).toISOString();
    }
    messages.push({ role: message.role, text, timestamp });
  }
  return { messages, startedAt, lastMessageAt };
}

export function buildExcerpt(
  messages: TranscriptMessage[],
  limit = DEFAULT_EXCERPT_MESSAGES,
): string {
  const slice = messages.slice(-Math.max(1, limit));
  const lines = slice.map((message) => {
    const label = message.role === "user" ? "User" : "Assistant";
    return `${label}: ${message.text}`;
  });
  let excerpt = lines.join("\n");
  if (excerpt.length > MAX_EXCERPT_CHARS) {
    excerpt = excerpt.slice(excerpt.length - MAX_EXCERPT_CHARS).trimStart();
  }
  return excerpt;
}

export function detectSignals(messages: TranscriptMessage[]): string[] {
  const combined = messages.map((msg) => msg.text).join("\n");
  const signals = new Set<string>();
  for (const rule of SIGNAL_RULES) {
    if (rule.regex.test(combined)) {
      signals.add(rule.label);
    }
  }
  return Array.from(signals);
}

export function shouldRecordConversation(params: {
  userCount: number;
  assistantCount: number;
  totalChars: number;
  signals: string[];
}): boolean {
  if (params.userCount === 0 || params.assistantCount === 0) {
    return false;
  }
  const messageCount = params.userCount + params.assistantCount;
  if (params.signals.length === 0) {
    if (messageCount < 4) {
      return false;
    }
    if (params.totalChars < 200) {
      return false;
    }
  }
  return true;
}

export function buildConversationEntry(params: {
  sessionEntry: SessionEntry;
  sessionKey?: string;
  agentId?: string;
  eventAction?: string;
  commandSource?: string;
  messages: TranscriptMessage[];
  startedAt?: string;
  lastMessageAt?: string;
  messageLimit?: number;
}): ConversationMemoryEntry | null {
  const userMessages = params.messages.filter((msg) => msg.role === "user");
  const assistantMessages = params.messages.filter((msg) => msg.role === "assistant");
  const totalChars = params.messages.reduce((sum, msg) => sum + msg.text.length, 0);
  const signals = detectSignals(params.messages);

  if (
    !shouldRecordConversation({
      userCount: userMessages.length,
      assistantCount: assistantMessages.length,
      totalChars,
      signals,
    })
  ) {
    return null;
  }

  const excerpt = buildExcerpt(params.messages, params.messageLimit ?? DEFAULT_EXCERPT_MESSAGES);
  const hash = hashText(`${params.sessionEntry.sessionId}:${excerpt}`);
  const id = `conv_${params.sessionEntry.sessionId}_${hash.slice(0, 12)}`;
  const now = new Date();

  return {
    entity_type: "ConversationMemory",
    id,
    hash,
    timestamp: now.toISOString(),
    session_id: params.sessionEntry.sessionId,
    session_key: params.sessionKey,
    agent_id: params.agentId,
    event_action: params.eventAction,
    source: params.commandSource,
    message_count: params.messages.length,
    user_messages: userMessages.length,
    assistant_messages: assistantMessages.length,
    total_chars: totalChars,
    excerpt,
    signals,
    started_at: params.startedAt,
    last_message_at: params.lastMessageAt,
    channel: params.sessionEntry.channel,
    thread_id: params.sessionEntry.lastThreadId ?? params.sessionEntry.origin?.threadId,
    account_id: params.sessionEntry.lastAccountId ?? params.sessionEntry.origin?.accountId,
    subject: params.sessionEntry.subject,
  };
}

type ConversationState = {
  sessions: Record<string, { hash: string; updatedAt: string; messageCount: number }>;
};

async function loadState(statePath: string): Promise<ConversationState> {
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as ConversationState;
    if (parsed && typeof parsed === "object" && parsed.sessions) {
      return parsed;
    }
  } catch {}
  return { sessions: {} };
}

async function saveState(statePath: string, state: ConversationState): Promise<void> {
  const next = { sessions: state.sessions };
  await fs.writeFile(statePath, JSON.stringify(next, null, 2) + "\n", "utf-8");
}

export async function recordConversationMemory(params: {
  sessionEntry: SessionEntry;
  sessionKey?: string;
  agentId?: string;
  eventAction?: string;
  commandSource?: string;
  workspaceDir?: string;
  messageLimit?: number;
}): Promise<{ recorded: boolean; reason?: string; entry?: ConversationMemoryEntry }> {
  const sessionId = params.sessionEntry.sessionId;
  if (!sessionId) {
    return { recorded: false, reason: "missing sessionId" };
  }

  const workspaceDir = params.workspaceDir?.trim() || DEFAULT_AGENT_WORKSPACE_DIR;
  const memoryDir = path.join(workspaceDir, "memory");
  await fs.mkdir(memoryDir, { recursive: true });

  const transcriptPath = resolveSessionFilePath(sessionId, params.sessionEntry, {
    agentId: params.agentId,
  });
  let raw: string;
  try {
    raw = await fs.readFile(transcriptPath, "utf-8");
  } catch {
    return { recorded: false, reason: "missing transcript" };
  }

  const parsed = parseTranscript(raw);
  if (parsed.messages.length === 0) {
    return { recorded: false, reason: "no messages" };
  }

  const entry = buildConversationEntry({
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    eventAction: params.eventAction,
    commandSource: params.commandSource,
    messages: parsed.messages,
    startedAt: parsed.startedAt,
    lastMessageAt: parsed.lastMessageAt,
    messageLimit: params.messageLimit,
  });

  if (!entry) {
    return { recorded: false, reason: "not-worthy" };
  }

  const statePath = path.join(memoryDir, "conversations-state.json");
  const state = await loadState(statePath);
  const existing = state.sessions[sessionId];
  if (existing?.hash === entry.hash) {
    return { recorded: false, reason: "duplicate" };
  }

  const jsonlPath = path.join(memoryDir, "conversations.jsonl");
  await fs.appendFile(jsonlPath, `${JSON.stringify(entry)}\n`, "utf-8");
  state.sessions[sessionId] = {
    hash: entry.hash,
    updatedAt: entry.timestamp,
    messageCount: entry.message_count,
  };
  await saveState(statePath, state);

  log.info(`Conversation memory stored (${sessionId})`, {
    messages: entry.message_count,
    signals: entry.signals,
  });

  return { recorded: true, entry };
}
