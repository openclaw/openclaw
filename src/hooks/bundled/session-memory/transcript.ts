import { isSqliteSessionTranscriptLocator } from "../../../config/sessions/paths.js";
import {
  loadSqliteSessionTranscriptEvents,
  resolveSqliteSessionTranscriptScope,
  resolveSqliteSessionTranscriptScopeForPath,
  type SqliteSessionTranscriptScope,
} from "../../../config/sessions/transcript-store.sqlite.js";
import { hasInterSessionUserProvenance } from "../../../sessions/input-provenance.js";

function extractTextMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      return candidate.text;
    }
  }
  return undefined;
}

export async function getRecentTranscriptContent(
  target:
    | string
    | {
        agentId?: string;
        sessionId?: string;
        transcriptPath?: string;
      },
  messageCount: number = 15,
): Promise<string | null> {
  try {
    const scope = resolveScopeForTranscriptTarget(target);
    if (!scope) {
      return null;
    }
    const events = loadSqliteSessionTranscriptEvents(scope);

    const allMessages: string[] = [];
    for (const { event } of events) {
      try {
        if (isRecord(event) && event.type === "message" && event.message) {
          const msg = event.message as {
            role?: unknown;
            content?: unknown;
            provenance?: unknown;
          };
          const role = msg.role;
          if ((role === "user" || role === "assistant") && "content" in msg && msg.content) {
            if (role === "user" && hasInterSessionUserProvenance(msg)) {
              continue;
            }
            const text = extractTextMessageContent(msg.content);
            if (text && !text.startsWith("/")) {
              allMessages.push(`${role}: ${text}`);
            }
          }
        }
      } catch {
        // Skip invalid transcript rows.
      }
    }

    return allMessages.slice(-messageCount).join("\n");
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function resolveScopeForTranscriptTarget(
  target:
    | string
    | {
        agentId?: string;
        sessionId?: string;
        transcriptPath?: string;
      },
): SqliteSessionTranscriptScope | undefined {
  if (typeof target !== "string") {
    const sessionId = target.sessionId?.trim();
    if (sessionId) {
      return resolveSqliteSessionTranscriptScope({
        agentId: target.agentId,
        sessionId,
      });
    }
    if (!target.transcriptPath?.trim()) {
      return undefined;
    }
    target = target.transcriptPath;
  }

  if (!isSqliteSessionTranscriptLocator(target)) {
    return undefined;
  }
  const byPath = resolveSqliteSessionTranscriptScopeForPath({ transcriptPath: target });
  return byPath;
}
