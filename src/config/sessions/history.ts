// src/config/sessions/history.ts
import fsPromises from "node:fs/promises";
import { SessionManager, type SessionEntry } from "@mariozechner/pi-coding-agent";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "./paths.js";
import { loadSessionStore, resolveSessionStoreEntry } from "./store.js";

export type SessionHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((c: { text?: string }) => c.text ?? "").join(" ");
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
  const effectiveLimit = limit > 0 ? limit : 10;
  try {
    const store = loadSessionStore(storePath);
    const { existing: entry } = resolveSessionStoreEntry({ store, sessionKey });
    if (!entry?.sessionId) {
      return [];
    }

    const opts = resolveSessionFilePathOptions({ agentId, storePath });
    const sessionFile = resolveSessionFilePath(entry.sessionId, entry, opts);

    try {
      await fsPromises.stat(sessionFile);
    } catch {
      return [];
    }

    const sessionManager = SessionManager.open(sessionFile);
    const entries: SessionEntry[] = sessionManager.getEntries();

    const messages: SessionHistoryMessage[] = [];
    for (const e of entries) {
      if (e.type !== "message" || !("message" in e) || !e.message?.role) {
        continue;
      }
      if (e.message.role !== "user" && e.message.role !== "assistant") {
        continue;
      }
      const content = extractTextContent(e.message.content);
      if (!content.trim()) {
        continue;
      }
      messages.push({
        role: e.message.role,
        content,
      });
    }

    return messages.slice(-effectiveLimit);
  } catch {
    return [];
  }
}
