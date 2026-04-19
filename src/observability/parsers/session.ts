import type { ParsedEvent, LogParser } from "./index.js";

/**
 * Session JSONL entry types based on src/memory/session-files.ts
 * and the pi-coding-agent SessionManager format.
 */
type SessionHeader = {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd?: string;
};

type SessionMessage = {
  type: "message";
  message: {
    role: string;
    content: unknown;
    api?: string;
    provider?: string;
    model?: string;
    usage?: {
      input?: number;
      output?: number;
      totalTokens?: number;
      cost?: { total?: number };
    };
    stopReason?: string;
    timestamp?: number;
  };
};

type SessionEntry = SessionHeader | SessionMessage | { type: string; [key: string]: unknown };

function isSessionHeader(value: unknown): value is SessionHeader {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return obj.type === "session" && typeof obj.version === "number" && typeof obj.id === "string";
}

function isSessionMessage(value: unknown): value is SessionMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return obj.type === "message" && obj.message !== null && typeof obj.message === "object";
}

function extractTextPreview(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.slice(0, 500);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  // Content is array of content blocks
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") {
      return record.text.slice(0, 500);
    }
  }
  return undefined;
}

function extractAgentIdFromPath(sourceFile: string): string | undefined {
  // Session files are typically at ~/.openclaw/agents/<agentId>/sessions/*.jsonl
  const match = sourceFile.match(/agents\/([^/]+)\/sessions\//);
  return match?.[1];
}

/**
 * Parses a single line of session JSONL.
 */
export function parseSessionLine(line: string, sourceFile: string): ParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) {
    return null;
  }

  let entry: SessionEntry;
  try {
    entry = JSON.parse(trimmed) as SessionEntry;
  } catch {
    return null;
  }

  if (!entry || typeof entry !== "object" || !entry.type) {
    return null;
  }

  const agentId = extractAgentIdFromPath(sourceFile);

  if (isSessionHeader(entry)) {
    return {
      ts: entry.timestamp,
      sourceType: "session",
      sourceFile,
      eventType: "session:start",
      sessionId: entry.id,
      agentId,
      rawJson: trimmed,
    };
  }

  if (isSessionMessage(entry)) {
    const msg = entry.message;
    const ts = msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString();

    return {
      ts,
      sourceType: "session",
      sourceFile,
      eventType: `session:message:${msg.role}`,
      sessionId: undefined, // Session ID is in header, not messages
      agentId,
      provider: msg.provider,
      modelId: msg.model,
      role: msg.role,
      messagePreview: extractTextPreview(msg.content),
      rawJson: trimmed,
    };
  }

  // Generic session entry
  return {
    ts: new Date().toISOString(),
    sourceType: "session",
    sourceFile,
    eventType: `session:${entry.type}`,
    agentId,
    rawJson: trimmed,
  };
}

/**
 * Session parser for session JSONL files.
 */
export const sessionParser: LogParser = {
  sourceType: "session",
  parseLine: parseSessionLine,
};
