import fs from "node:fs/promises";
import path from "node:path";
import { normalizeTimestamp } from "../../../agents/date-time.js";
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

export type SessionTranscriptExcerpt = {
  content: string | null;
  lastMessageTimestampMs?: number;
};

export async function getRecentSessionExcerpt(
  sessionFilePath: string,
  messageCount: number = 15,
): Promise<SessionTranscriptExcerpt> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");

    const allMessages: string[] = [];
    let lastMessageTimestampMs: number | undefined;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message) {
          const msg = entry.message as {
            role?: unknown;
            content?: unknown;
            provenance?: unknown;
            timestamp?: unknown;
          };
          const role = msg.role;
          if ((role === "user" || role === "assistant") && "content" in msg && msg.content) {
            if (role === "user" && hasInterSessionUserProvenance(msg)) {
              continue;
            }
            const text = extractTextMessageContent(msg.content);
            if (text && !text.startsWith("/")) {
              allMessages.push(`${role}: ${text}`);
              const normalizedTimestamp = normalizeTimestamp(entry.timestamp ?? msg.timestamp);
              if (normalizedTimestamp) {
                lastMessageTimestampMs = normalizedTimestamp.timestampMs;
              }
            }
          }
        }
      } catch {
        // Skip invalid JSON lines.
      }
    }

    const recentMessages = allMessages.slice(-messageCount);
    return {
      content: recentMessages.length > 0 ? recentMessages.join("\n") : null,
      lastMessageTimestampMs,
    };
  } catch {
    return { content: null };
  }
}

export async function getRecentSessionContent(
  sessionFilePath: string,
  messageCount: number = 15,
): Promise<string | null> {
  return (await getRecentSessionExcerpt(sessionFilePath, messageCount)).content;
}

export async function getRecentSessionExcerptWithResetFallback(
  sessionFilePath: string,
  messageCount: number = 15,
): Promise<SessionTranscriptExcerpt> {
  const primary = await getRecentSessionExcerpt(sessionFilePath, messageCount);
  if (primary.content) {
    return primary;
  }

  try {
    const dir = path.dirname(sessionFilePath);
    const base = path.basename(sessionFilePath);
    const resetPrefix = `${base}.reset.`;
    const files = await fs.readdir(dir);
    const resetCandidates = files.filter((name) => name.startsWith(resetPrefix)).toSorted();

    if (resetCandidates.length === 0) {
      return primary;
    }

    const latestResetPath = path.join(dir, resetCandidates[resetCandidates.length - 1]);
    const fallback = await getRecentSessionExcerpt(latestResetPath, messageCount);
    return fallback.content ? fallback : primary;
  } catch {
    return primary;
  }
}

export async function getRecentSessionContentWithResetFallback(
  sessionFilePath: string,
  messageCount: number = 15,
): Promise<string | null> {
  return (await getRecentSessionExcerptWithResetFallback(sessionFilePath, messageCount)).content;
}

export function stripResetSuffix(fileName: string): string {
  const resetIndex = fileName.indexOf(".reset.");
  return resetIndex === -1 ? fileName : fileName.slice(0, resetIndex);
}

export async function findPreviousSessionFile(params: {
  sessionsDir: string;
  currentSessionFile?: string;
  sessionId?: string;
}): Promise<string | undefined> {
  try {
    const files = await fs.readdir(params.sessionsDir);
    const fileSet = new Set(files);

    const baseFromReset = params.currentSessionFile
      ? stripResetSuffix(path.basename(params.currentSessionFile))
      : undefined;
    if (baseFromReset && fileSet.has(baseFromReset)) {
      return path.join(params.sessionsDir, baseFromReset);
    }

    const trimmedSessionId = params.sessionId?.trim();
    if (trimmedSessionId) {
      const canonicalFile = `${trimmedSessionId}.jsonl`;
      if (fileSet.has(canonicalFile)) {
        return path.join(params.sessionsDir, canonicalFile);
      }

      const topicVariants = files
        .filter(
          (name) =>
            name.startsWith(`${trimmedSessionId}-topic-`) &&
            name.endsWith(".jsonl") &&
            !name.includes(".reset."),
        )
        .toSorted()
        .toReversed();
      if (topicVariants.length > 0) {
        return path.join(params.sessionsDir, topicVariants[0]);
      }
    }

    if (!params.currentSessionFile) {
      return undefined;
    }

    const nonResetJsonl = files
      .filter((name) => name.endsWith(".jsonl") && !name.includes(".reset."))
      .toSorted()
      .toReversed();
    if (nonResetJsonl.length > 0) {
      return path.join(params.sessionsDir, nonResetJsonl[0]);
    }
  } catch {
    // Ignore directory read errors.
  }
  return undefined;
}
