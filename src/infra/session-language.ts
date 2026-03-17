import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveAgentIdFromSessionKey,
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
  type SessionEntry,
  loadSessionStore,
} from "../config/sessions.js";

export type SessionReplyLanguage = "zh-Hans" | "en" | "ja" | "ko";

/** Maximum number of lines to scan backwards from end of transcript. */
const MAX_SCAN_LINES = 100;

function extractUserTextFromTranscriptLine(rawLine: string): string | undefined {
  const trimmed = rawLine.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      type?: string;
      message?: {
        role?: string;
        content?: unknown;
      };
    };
    if (parsed.type !== "message" || parsed.message?.role !== "user") {
      return undefined;
    }
    const content = parsed.message?.content;
    if (typeof content === "string") {
      return content.trim() || undefined;
    }
    if (!Array.isArray(content)) {
      return undefined;
    }
    const joined = content
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return "";
        }
        const candidate = entry as { type?: unknown; text?: unknown };
        if (
          candidate.type === "text" ||
          candidate.type === "input_text" ||
          candidate.type === "output_text"
        ) {
          return typeof candidate.text === "string" ? candidate.text : "";
        }
        return "";
      })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return joined || undefined;
  } catch {
    return undefined;
  }
}

export function detectSessionReplyLanguageFromText(text: string): SessionReplyLanguage | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  const hanCount = (normalized.match(/[\u3400-\u9fff]/gu) ?? []).length;
  const latinCount = (normalized.match(/[A-Za-z]/g) ?? []).length;
  if (hanCount >= 2 && hanCount >= latinCount / 2) {
    // Check for kana to differentiate Japanese (Han + kana) from Chinese (Han only).
    // This block must come before the kana-only check below.
    const kanaCount = (normalized.match(/[\u3040-\u309f\u30a0-\u30ff]/gu) ?? []).length;
    if (kanaCount >= 2) {
      return "ja";
    }
    return "zh-Hans";
  }
  // Japanese: Hiragana (U+3040-309F) + Katakana (U+30A0-30FF), no significant Han chars
  const kanaCount = (normalized.match(/[\u3040-\u309f\u30a0-\u30ff]/gu) ?? []).length;
  if (kanaCount >= 2 && kanaCount >= latinCount / 2) {
    return "ja";
  }
  // Korean: Hangul Syllables (U+AC00-D7AF) + Jamo (U+1100-11FF)
  const hangulCount = (normalized.match(/[\uac00-\ud7af\u1100-\u11ff]/gu) ?? []).length;
  if (hangulCount >= 2 && hangulCount >= latinCount / 2) {
    return "ko";
  }
  if (latinCount >= 6 && hanCount === 0) {
    return "en";
  }
  return undefined;
}

async function inferSessionReplyLanguageFromTranscript(params: {
  sessionKey: string;
  storePath: string;
  entry?: SessionEntry;
  agentId?: string;
}): Promise<SessionReplyLanguage | undefined> {
  const { sessionKey, storePath } = params;
  const sessionStore = loadSessionStore(storePath, { skipCache: true });
  const entry = params.entry ?? sessionStore[sessionKey];
  const sessionId = entry?.sessionId?.trim();
  if (!sessionId) {
    return undefined;
  }
  try {
    const transcriptPath = resolveSessionFilePath(sessionId, entry, {
      agentId: params.agentId,
      sessionsDir: path.dirname(storePath),
    });
    const content = await fs.readFile(transcriptPath, "utf-8");
    const lines = content.split("\n");
    // Only scan the last MAX_SCAN_LINES lines to avoid slow scans on large transcripts.
    const startIdx = Math.max(0, lines.length - MAX_SCAN_LINES);
    for (let idx = lines.length - 1; idx >= startIdx; idx -= 1) {
      const userText = extractUserTextFromTranscriptLine(lines[idx] ?? "");
      if (!userText) {
        continue;
      }
      const detected = detectSessionReplyLanguageFromText(userText);
      if (detected) {
        return detected;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function inferSessionReplyLanguage(params: {
  sessionKey: string;
  storePath?: string;
  entry?: SessionEntry;
  agentId?: string;
}): Promise<SessionReplyLanguage | undefined> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const primaryStorePath = params.storePath ?? resolveDefaultSessionStorePath(agentId);
  const detected = await inferSessionReplyLanguageFromTranscript({
    sessionKey,
    storePath: primaryStorePath,
    entry: params.entry,
    agentId,
  });
  if (detected) {
    return detected;
  }
  return undefined;
}
