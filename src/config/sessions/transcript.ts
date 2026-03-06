import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import type { SessionEntry } from "./types.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { resolveDefaultSessionStorePath, resolveSessionTranscriptPath } from "./paths.js";
import { loadSessionStore, updateSessionStore } from "./store.js";

function stripQuery(value: string): string {
  const noHash = value.split("#")[0] ?? value;
  return noHash.split("?")[0] ?? noHash;
}

function extractFileNameFromMediaUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const cleaned = stripQuery(trimmed);
  try {
    const parsed = new URL(cleaned);
    const base = path.basename(parsed.pathname);
    if (!base) {
      return null;
    }
    try {
      return decodeURIComponent(base);
    } catch {
      return base;
    }
  } catch {
    const base = path.basename(cleaned);
    if (!base || base === "/" || base === ".") {
      return null;
    }
    return base;
  }
}

export function resolveMirroredTranscriptText(params: {
  text?: string;
  mediaUrls?: string[];
}): string | null {
  const mediaUrls = params.mediaUrls?.filter((url) => url && url.trim()) ?? [];
  if (mediaUrls.length > 0) {
    const names = mediaUrls
      .map((url) => extractFileNameFromMediaUrl(url))
      .filter((name): name is string => Boolean(name && name.trim()));
    if (names.length > 0) {
      return names.join(", ");
    }
    return "media";
  }

  const text = params.text ?? "";
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

async function ensureSessionHeader(params: {
  sessionFile: string;
  sessionId: string;
}): Promise<void> {
  if (fs.existsSync(params.sessionFile)) {
    return;
  }
  await fs.promises.mkdir(path.dirname(params.sessionFile), { recursive: true });
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  await fs.promises.writeFile(params.sessionFile, `${JSON.stringify(header)}\n`, "utf-8");
}

/**
 * Default number of user turns to carry over from a previous session
 * when a new session starts (daily/idle reset or gateway restart).
 */
const HISTORY_SEED_TURNS = 10;

type JsonlEntry = {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
};

/**
 * Seed a new session's JSONL transcript with the last N user/assistant
 * turns from a previous session. This provides continuity across session
 * resets (daily, idle, restart) so the agent doesn't lose recent
 * conversation context.
 *
 * Only user and assistant messages are carried over; tool messages and
 * other entry types are skipped. The seeded turns are written after the
 * session header so `readSessionHistory` picks them up naturally.
 *
 * This is a no-op when:
 * - The previous session file doesn't exist or is empty
 * - The new session file already has content (avoid double-seeding)
 * - No user/assistant turns are found in the previous session
 */
export async function seedSessionHistoryFromPrevious(params: {
  previousSessionFile: string;
  newSessionFile: string;
  newSessionId: string;
  maxUserTurns?: number;
}): Promise<{ seeded: boolean; turnCount: number }> {
  const maxUserTurns = params.maxUserTurns ?? HISTORY_SEED_TURNS;

  // Don't seed if the new session file already has content.
  try {
    const stat = await fs.promises.stat(params.newSessionFile);
    if (stat.size > 0) {
      return { seeded: false, turnCount: 0 };
    }
  } catch {
    // File doesn't exist yet; we'll create it.
  }

  // Read the previous session's transcript.
  let previousContent: string;
  try {
    previousContent = await fs.promises.readFile(params.previousSessionFile, "utf-8");
  } catch {
    return { seeded: false, turnCount: 0 };
  }

  if (!previousContent.trim()) {
    return { seeded: false, turnCount: 0 };
  }

  // Parse all user/assistant message entries from the previous session.
  type MessageEntry = { role: "user" | "assistant"; line: string };
  const messages: MessageEntry[] = [];

  for (const line of previousContent.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line) as JsonlEntry;
    } catch {
      continue;
    }
    if (entry.type !== "message" || !entry.message) {
      continue;
    }
    const role = entry.message.role;
    if (role === "user" || role === "assistant") {
      messages.push({ role, line });
    }
  }

  if (messages.length === 0) {
    return { seeded: false, turnCount: 0 };
  }

  // Keep the last N user turns and their associated assistant responses.
  let userCount = 0;
  let cutIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > maxUserTurns) {
        cutIndex = i + 1;
        break;
      }
    }
  }
  const kept = cutIndex < messages.length ? messages.slice(cutIndex) : messages;

  if (kept.length === 0) {
    return { seeded: false, turnCount: 0 };
  }

  // Write session header + seeded turns to the new session file.
  await fs.promises.mkdir(path.dirname(params.newSessionFile), { recursive: true });
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.newSessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    seededFrom: params.previousSessionFile,
  };
  const lines = [JSON.stringify(header), ...kept.map((m) => m.line)];
  await fs.promises.writeFile(params.newSessionFile, `${lines.join("\n")}\n`, "utf-8");

  return { seeded: true, turnCount: kept.length };
}

export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  text?: string;
  mediaUrls?: string[];
  /** Optional override for store path (mostly for tests). */
  storePath?: string;
}): Promise<{ ok: true; sessionFile: string } | { ok: false; reason: string }> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }

  const mirrorText = resolveMirroredTranscriptText({
    text: params.text,
    mediaUrls: params.mediaUrls,
  });
  if (!mirrorText) {
    return { ok: false, reason: "empty text" };
  }

  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  const store = loadSessionStore(storePath, { skipCache: true });
  const entry = store[sessionKey] as SessionEntry | undefined;
  if (!entry?.sessionId) {
    return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };
  }

  const sessionFile =
    entry.sessionFile?.trim() || resolveSessionTranscriptPath(entry.sessionId, params.agentId);

  await ensureSessionHeader({ sessionFile, sessionId: entry.sessionId });

  const sessionManager = SessionManager.open(sessionFile);
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: mirrorText }],
    api: "openai-responses",
    provider: "openclaw",
    model: "delivery-mirror",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });

  if (!entry.sessionFile || entry.sessionFile !== sessionFile) {
    await updateSessionStore(storePath, (current) => {
      current[sessionKey] = {
        ...entry,
        sessionFile,
      };
    });
  }

  emitSessionTranscriptUpdate(sessionFile);
  return { ok: true, sessionFile };
}
