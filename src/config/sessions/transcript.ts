import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { resolveDefaultSessionStorePath } from "./paths.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import { loadSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

/**
 * Extract peer metadata from a session key.
 * Session key format: agent:<agentId>:<channel>:<chatType>:<peerId>
 * Examples:
 *   - agent:main:feishu:direct:ou_cadc2c270c8e9803d8f069eb8ce19b75
 *   - agent:main:telegram:group:-1001234567890
 *   - agent:main:whatsapp:direct:+1234567890
 */
function extractPeerInfoFromSessionKey(sessionKey: string): {
  id: string;
  channel: string;
  chatType: "direct" | "group";
  accountId?: string;
} | null {
  const parts = sessionKey.split(":");
  if (!parts[0] || parts[0] !== "agent") {
    return null;
  }
  // Format: agent:<agentId>:<channel>:<chatType>:<peerId>
  // or: agent:<agentId>:<channel>:<accountId>:<chatType>:<peerId>
  if (parts.length < 5) {
    return null;
  }
  const channel = parts[2] || "unknown";
  // Check if this is the per-account format (6 parts)
  if (parts.length === 6) {
    const accountId = parts[3];
    const chatType = parts[4] as "direct" | "group";
    const peerId = parts[5];
    return { id: peerId, channel, chatType, accountId };
  }
  // Standard format (5 parts)
  const chatType = parts[3] as "direct" | "group";
  const peerId = parts[4];
  if (!chatType || !peerId) {
    return null;
  }
  return { id: peerId, channel, chatType };
}

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
  /** Optional peer metadata for chat extraction and session identification. */
  peerInfo?: {
    /** Peer identifier (e.g., user ID, phone number, address). */
    id: string;
    /** Display name if available (e.g., contact name, push name). */
    name?: string;
    /** Channel identifier (e.g., "telegram", "whatsapp", "feishu"). */
    channel: string;
    /** Chat type: "direct" or "group". */
    chatType: "direct" | "group";
    /** Account identifier for multi-account setups. */
    accountId?: string;
  };
}): Promise<void> {
  if (fs.existsSync(params.sessionFile)) {
    return;
  }
  await fs.promises.mkdir(path.dirname(params.sessionFile), { recursive: true });
  const header: Record<string, unknown> = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  // Include peer metadata if provided (useful for chat extraction and session management)
  if (params.peerInfo) {
    header.peer = params.peerInfo;
  }
  await fs.promises.writeFile(params.sessionFile, `${JSON.stringify(header)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
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

  let sessionFile: string;
  try {
    const resolvedSessionFile = await resolveAndPersistSessionFile({
      sessionId: entry.sessionId,
      sessionKey,
      sessionStore: store,
      storePath,
      sessionEntry: entry,
      agentId: params.agentId,
      sessionsDir: path.dirname(storePath),
    });
    sessionFile = resolvedSessionFile.sessionFile;
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // Extract peer metadata from session key for chat extraction
  const peerInfo = extractPeerInfoFromSessionKey(sessionKey);
  await ensureSessionHeader({
    sessionFile,
    sessionId: entry.sessionId,
    peerInfo: peerInfo || undefined,
  });

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

  emitSessionTranscriptUpdate(sessionFile);
  return { ok: true, sessionFile };
}
