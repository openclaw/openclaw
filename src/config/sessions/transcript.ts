import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { parseSessionThreadInfo } from "./delivery-info.js";
import {
  ensurePrivateSessionsDir,
  isManagedSessionTranscriptPath,
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
} from "./paths.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import { loadSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

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
  const sessionDir = path.dirname(params.sessionFile);
  if (isManagedSessionTranscriptPath(params.sessionFile)) {
    await ensurePrivateSessionsDir(sessionDir);
  } else {
    await fs.promises.mkdir(sessionDir, { recursive: true });
  }
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  await fs.promises.writeFile(params.sessionFile, `${JSON.stringify(header)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export async function resolveSessionTranscriptFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  agentId: string;
  threadId?: string | number;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry | undefined }> {
  const sessionPathOpts = resolveSessionFilePathOptions({
    agentId: params.agentId,
    storePath: params.storePath,
  });
  let sessionFile = resolveSessionFilePath(params.sessionId, params.sessionEntry, sessionPathOpts);
  let sessionEntry = params.sessionEntry;

  if (params.sessionStore && params.storePath) {
    const threadIdFromSessionKey = parseSessionThreadInfo(params.sessionKey).threadId;
    const fallbackSessionFile = !sessionEntry?.sessionFile
      ? resolveSessionTranscriptPath(
          params.sessionId,
          params.agentId,
          params.threadId ?? threadIdFromSessionKey,
        )
      : undefined;
    const resolvedSessionFile = await resolveAndPersistSessionFile({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
      sessionEntry,
      agentId: sessionPathOpts?.agentId,
      sessionsDir: sessionPathOpts?.sessionsDir,
      fallbackSessionFile,
    });
    sessionFile = resolvedSessionFile.sessionFile;
    sessionEntry = resolvedSessionFile.sessionEntry;
  }

  return {
    sessionFile,
    sessionEntry,
  };
}

export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  text?: string;
  mediaUrls?: string[];
  idempotencyKey?: string;
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

  await ensureSessionHeader({ sessionFile, sessionId: entry.sessionId });

  if (
    params.idempotencyKey &&
    (await transcriptHasIdempotencyKey(sessionFile, params.idempotencyKey))
  ) {
    return { ok: true, sessionFile };
  }

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
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
  });

  emitSessionTranscriptUpdate(sessionFile);
  return { ok: true, sessionFile };
}

async function transcriptHasIdempotencyKey(
  transcriptPath: string,
  idempotencyKey: string,
): Promise<boolean> {
  try {
    const raw = await fs.promises.readFile(transcriptPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { message?: { idempotencyKey?: unknown } };
        if (parsed.message?.idempotencyKey === idempotencyKey) {
          return true;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return false;
  }
  return false;
}
