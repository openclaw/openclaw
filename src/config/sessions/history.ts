// src/config/sessions/history.ts
import fsPromises from "node:fs/promises";
import { SessionManager, type SessionEntry } from "@mariozechner/pi-coding-agent";
import { hasInterSessionUserProvenance } from "../../sessions/input-provenance.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "./paths.js";
import { loadSessionStore, resolveSessionStoreEntry } from "./store.js";

export type SessionHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

const SKIP_BLOCK_TYPES = new Set([
  // snake_case variants
  "tool_use",
  "tool_result",
  "tool_call",
  // camelCase variants
  "toolCall",
  "toolUse",
  "toolResult",
  "functionCall",
  // internal aliases
  "toolcall",
  // reasoning blocks (not user-visible)
  "thinking",
]);

function isToolOrReasoningBlock(type?: string): boolean {
  return !!type && SKIP_BLOCK_TYPES.has(type);
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content as Array<{ type?: string; text?: string }>) {
      if (c.text) {
        parts.push(c.text);
      } else if (c.type === "image") {
        parts.push("[image]");
      } else if (isToolOrReasoningBlock(c.type)) {
        // skip tool and reasoning blocks
      } else if (c.type) {
        parts.push(`[${c.type}]`);
      }
    }
    return parts.join(" ");
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
 *
 * Note: reads entries in append order. In sessions with `/tree` branches or
 * auto-compaction, this may include turns from inactive branches. For most
 * channel-plugin use cases (recent context injection) this is acceptable;
 * consumers needing branch-accurate history should use the gateway API instead.
 *
 * Limitation: older topic/thread sessions without a persisted `sessionFile`
 * entry may not be found, as this helper does not perform the topic-specific
 * path fallback that `resolveAndPersistSessionFile` provides.
 */
export async function readSessionRecentMessages(params: {
  /**
   * Path to the sessions store (sessions.json). For non-main agents, callers
   * must pass the agent-specific store path (e.g., via
   * `rt.channel.session.resolveStorePath(cfg.session?.store, { agentId })`).
   */
  storePath: string;
  sessionKey: string;
  /** Agent ID used as a hint for session file path resolution. */
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
      // Skip synthetic inter-session messages (e.g., sessions_send, subagent
      // announcements) to avoid leaking internal agent traffic into plugin context.
      if (hasInterSessionUserProvenance(e.message)) {
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
