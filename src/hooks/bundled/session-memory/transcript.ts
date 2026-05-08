import path from "node:path";
import {
  listSqliteSessionTranscriptFiles,
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
  transcriptPath: string,
  messageCount: number = 15,
): Promise<string | null> {
  try {
    const scope = resolveScopeForTranscriptPath(transcriptPath);
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
        // Skip invalid JSON lines.
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

function extractSessionIdFromTranscriptPath(transcriptPath: string): string | undefined {
  const base = path.basename(transcriptPath);
  if (!base.endsWith(".jsonl")) {
    return undefined;
  }
  const stem = base.slice(0, -".jsonl".length);
  const topicIndex = stem.indexOf("-topic-");
  return topicIndex > 0 ? stem.slice(0, topicIndex) : stem || undefined;
}

function resolveScopeForTranscriptPath(
  transcriptPath: string,
): SqliteSessionTranscriptScope | undefined {
  const byPath = resolveSqliteSessionTranscriptScopeForPath({ transcriptPath });
  if (byPath) {
    return byPath;
  }
  const sessionId = extractSessionIdFromTranscriptPath(transcriptPath);
  if (!sessionId) {
    return undefined;
  }
  return resolveSqliteSessionTranscriptScope({
    sessionId,
    transcriptPath,
  });
}

function resolveRememberedPathInSessionsDir(params: {
  sessionsDir: string;
  sessionId: string;
}): string | undefined {
  const sessionsDir = path.resolve(params.sessionsDir);
  const candidates = listSqliteSessionTranscriptFiles()
    .filter((file) => path.dirname(path.resolve(file.path)) === sessionsDir)
    .filter((file) => file.sessionId === params.sessionId)
    .toSorted((a, b) => {
      const updatedDelta = b.updatedAt - a.updatedAt;
      return updatedDelta || b.path.localeCompare(a.path);
    });

  if (candidates.length === 0) {
    return undefined;
  }

  const canonicalPath = path.join(sessionsDir, `${params.sessionId}.jsonl`);
  const canonical = candidates.find((file) => path.resolve(file.path) === canonicalPath);
  return canonical?.path ?? candidates[0]?.path;
}

export async function findPreviousTranscriptPath(params: {
  sessionsDir: string;
  sessionId?: string;
}): Promise<string | undefined> {
  try {
    const trimmedSessionId = params.sessionId?.trim();
    if (trimmedSessionId) {
      const rememberedPath = resolveRememberedPathInSessionsDir({
        sessionsDir: params.sessionsDir,
        sessionId: trimmedSessionId,
      });
      if (rememberedPath) {
        return rememberedPath;
      }

      const scope = resolveSqliteSessionTranscriptScope({
        sessionId: trimmedSessionId,
        transcriptPath: path.join(params.sessionsDir, `${trimmedSessionId}.jsonl`),
      });
      if (scope) {
        return path.join(params.sessionsDir, `${trimmedSessionId}.jsonl`);
      }
    }
  } catch {
    // Ignore directory read errors.
  }
  return undefined;
}
