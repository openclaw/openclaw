// Session memory transcript helpers persist compact session transcript excerpts.
import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeModelSpecialTokens } from "../../../security/external-content.js";
import { hasInterSessionUserProvenance } from "../../../sessions/input-provenance.js";
import { isOpenClawDeliveryMirrorAssistantMessage } from "../../../shared/transcript-only-openclaw-assistant.js";

const SESSION_MEMORY_TOOL_DIRECTIVE_PREFIX = String.raw`(?:(?:\|DSML\|)|(?:\uFF5CDSML\uFF5C))?`;
const SESSION_MEMORY_TOOL_DIRECTIVE_KIND = String.raw`(?:tool_calls?|function_calls?|tool_use_error)`;
const SESSION_MEMORY_DROP_BLOCK_RE = new RegExp(
  String.raw`<${SESSION_MEMORY_TOOL_DIRECTIVE_PREFIX}${SESSION_MEMORY_TOOL_DIRECTIVE_KIND}\b[^>]*>` +
    String.raw`[\s\S]*?(?:<\/${SESSION_MEMORY_TOOL_DIRECTIVE_PREFIX}${SESSION_MEMORY_TOOL_DIRECTIVE_KIND}>|$)`,
  "gi",
);
const SESSION_MEMORY_ROLE_DIRECTIVE_BLOCK_RE = /<(system|assistant|user)\b[^>]*>[\s\S]*?<\/\1>/gi;
const SESSION_MEMORY_ROLE_DIRECTIVE_TAG_RE = /<\/?(?:system|assistant|user)\b[^>]*>/gi;
const SESSION_MEMORY_MEDIA_PLACEHOLDER_RE = /(^|\n)\s*<media:[^>]+>(?:\s*\([^)]*\))?\s*/gi;
const SESSION_MEMORY_TRAILING_NO_REPLY_RE = /(?:^|\n)\s*NO_REPLY\s*$/i;
const SESSION_MEMORY_LINE_BREAK_RE = /\r\n|[\r\n\u2028\u2029]/g;
const SESSION_MEMORY_ROLE_LINE_RE = new RegExp(
  `(?:^|${SESSION_MEMORY_LINE_BREAK_RE.source})` +
    String.raw`[ \t]*(?:user|assistant|system)[ \t]*:?[ \t]*` +
    `(?=${SESSION_MEMORY_LINE_BREAK_RE.source}|$)`,
  "i",
);

function isNoReplyMarker(text: string): boolean {
  const trimmed = text.trim();
  return /^NO_REPLY$/i.test(trimmed) || /^\{\s*"action"\s*:\s*"NO_REPLY"\s*\}$/i.test(trimmed);
}

export function sanitizeSessionMemoryTranscriptText(text: string): string | null {
  if (isNoReplyMarker(text)) {
    return null;
  }
  const withoutArtifacts = sanitizeModelSpecialTokens(text)
    .replace(SESSION_MEMORY_DROP_BLOCK_RE, "")
    .replace(SESSION_MEMORY_ROLE_DIRECTIVE_BLOCK_RE, "")
    .replace(SESSION_MEMORY_ROLE_DIRECTIVE_TAG_RE, "")
    .replace(SESSION_MEMORY_MEDIA_PLACEHOLDER_RE, "$1")
    .replace(SESSION_MEMORY_TRAILING_NO_REPLY_RE, "");
  const withoutBoundaryBlankLines = withoutArtifacts
    .replace(/^(?:[ \t]*(?:\r\n|[\r\n]))+/, "")
    .replace(/(?:(?:\r\n|[\r\n])[ \t]*)+$/, "");

  return withoutBoundaryBlankLines.trim() ? withoutBoundaryBlankLines : null;
}

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

function formatTranscriptMessage(role: "user" | "assistant", text: string): string {
  if (role === "assistant" && SESSION_MEMORY_ROLE_LINE_RE.test(text)) {
    // Keep model bytes intact inside one container. Role-shaped lines become
    // non-standalone, and open code fences end at this message boundary.
    const quoted = `> ${text.replace(SESSION_MEMORY_LINE_BREAK_RE, (lineBreak) => `${lineBreak}> `)}`;
    return `**assistant:**\n\n${quoted}\n`;
  }
  return `${role}: ${text}`;
}

export async function getRecentSessionContent(
  sessionFilePath: string,
  messageCount = 15,
): Promise<string | null> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");

    const allMessages: string[] = [];
    let lastAssistantCanonicalText: string | undefined;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message) {
          const msg = entry.message as {
            role?: unknown;
            content?: unknown;
            provenance?: unknown;
          };
          const role = msg.role;
          if ((role === "user" || role === "assistant") && "content" in msg && msg.content) {
            if (role === "user" && hasInterSessionUserProvenance(msg)) {
              continue;
            }
            if (role === "user") {
              // New turn: reset even when slash commands are omitted from
              // memory, so later standalone delivery mirrors are preserved.
              lastAssistantCanonicalText = undefined;
            }
            const text = extractTextMessageContent(msg.content);
            const sanitized = text ? sanitizeSessionMemoryTranscriptText(text) : null;
            const canonicalText = sanitized?.trim();
            // Skip delivery-mirror rows only when they duplicate the preceding
            // assistant text. Delivery-mirror rows with unique visible content
            // (e.g., message-tool replies) are preserved.
            if (isOpenClawDeliveryMirrorAssistantMessage(msg)) {
              if (canonicalText && canonicalText === lastAssistantCanonicalText) {
                continue;
              }
            }
            if (sanitized && canonicalText && !canonicalText.startsWith("/")) {
              allMessages.push(formatTranscriptMessage(role, sanitized));
              if (role === "assistant") {
                // Delivery mirrors trim outer whitespace at write time. Keep
                // display bytes lossless, but deduplicate their canonical form.
                lastAssistantCanonicalText = canonicalText;
              }
            }
          }
        }
      } catch {
        // Skip invalid JSON lines.
      }
    }

    return allMessages.slice(-messageCount).join("\n").replace(/\n+$/, "");
  } catch {
    return null;
  }
}

export async function getRecentSessionContentWithResetFallback(
  sessionFilePath: string,
  messageCount = 15,
): Promise<string | null> {
  const primary = await getRecentSessionContent(sessionFilePath, messageCount);
  if (primary) {
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
    return (await getRecentSessionContent(latestResetPath, messageCount)) || primary;
  } catch {
    return primary;
  }
}

function stripResetSuffix(fileName: string): string {
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

    const currentBaseName = params.currentSessionFile
      ? path.basename(params.currentSessionFile)
      : undefined;
    const baseFromReset = currentBaseName ? stripResetSuffix(currentBaseName) : undefined;
    if (baseFromReset && fileSet.has(baseFromReset)) {
      return path.join(params.sessionsDir, baseFromReset);
    }
    if (currentBaseName?.includes(".reset.") && fileSet.has(currentBaseName)) {
      return path.join(params.sessionsDir, currentBaseName);
    }

    const trimmedSessionId = params.sessionId?.trim();
    if (trimmedSessionId) {
      const canonicalFile = `${trimmedSessionId}.jsonl`;
      if (fileSet.has(canonicalFile)) {
        return path.join(params.sessionsDir, canonicalFile);
      }

      const canonicalResetVariants = files
        .filter((name) => name.startsWith(`${canonicalFile}.reset.`))
        .toSorted()
        .toReversed();
      if (canonicalResetVariants.length > 0) {
        return path.join(params.sessionsDir, canonicalResetVariants[0]);
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

      const topicResetVariants = files
        .filter(
          (name) => name.startsWith(`${trimmedSessionId}-topic-`) && name.includes(".jsonl.reset."),
        )
        .toSorted()
        .toReversed();
      if (topicResetVariants.length > 0) {
        return path.join(params.sessionsDir, topicResetVariants[0]);
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

    const resetJsonl = files
      .filter((name) => name.includes(".jsonl.reset."))
      .toSorted()
      .toReversed();
    if (resetJsonl.length > 0) {
      return path.join(params.sessionsDir, resetJsonl[0]);
    }
  } catch {
    // Ignore directory read errors.
  }
  return undefined;
}
