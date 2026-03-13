// src/config/sessions/history.ts
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "./paths.js";
import { loadSessionStore, resolveSessionStoreEntry } from "./store.js";

export type SessionHistoryMessage = {
  role: string;
  content: string;
  senderName?: string;
};

type MessageEntry = {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    senderName?: string;
  };
};

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((c: { text?: string }) => c.text ?? "").join("");
  }
  return "";
}

/**
 * Read recent messages from a session transcript.
 *
 * Returns the last `limit` user/assistant messages from the session identified
 * by `sessionKey` in the given store. Returns an empty array on any error
 * (missing session, missing file, parse error) — callers should treat an empty
 * result as "no history available" rather than an error.
 */
export async function readSessionRecentMessages(params: {
  storePath: string;
  sessionKey: string;
  /** Agent ID used to resolve the sessions directory (default: main agent). */
  agentId?: string;
  /** Maximum number of messages to return, counting from the end (default: 10). */
  limit?: number;
}): Promise<SessionHistoryMessage[]> {
  const { storePath, sessionKey, agentId, limit = 10 } = params;
  try {
    const store = loadSessionStore(storePath);
    const { existing: entry } = resolveSessionStoreEntry({ store, sessionKey });
    if (!entry?.sessionId) {
      return [];
    }

    const opts = resolveSessionFilePathOptions({ agentId, storePath });
    const sessionFile = resolveSessionFilePath(entry.sessionId, entry, opts);

    const sessionManager = SessionManager.open(sessionFile);
    const entries = sessionManager.getEntries() as MessageEntry[];

    const messages: SessionHistoryMessage[] = [];
    for (const e of entries) {
      if (e.type !== "message" || !e.message?.role) {
        continue;
      }
      const content = extractTextContent(e.message.content);
      if (!content.trim()) {
        continue;
      }
      messages.push({
        role: e.message.role,
        content,
        senderName: e.message.senderName,
      });
    }

    return messages.slice(-limit);
  } catch {
    return [];
  }
}
