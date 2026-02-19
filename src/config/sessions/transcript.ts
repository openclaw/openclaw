import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let AeonMemoryPlugin: any = null;
// @ts-ignore: Optional dependency for ultra-low-latency memory
import("aeon-memory")
  .then((m) => {
    AeonMemoryPlugin = m.AeonMemory;
  })
  .catch((e: unknown) => {
    const code = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined;
    if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") {
      console.error("🚨 [AeonMemory] Load failed:", e);
    }
  });
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { resolveDefaultSessionStorePath, resolveSessionFilePath } from "./paths.js";
import { loadSessionStore, updateSessionStore } from "./store.js";
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
  await fs.promises.mkdir(path.dirname(params.sessionFile), { recursive: true });
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
    sessionFile = resolveSessionFilePath(entry.sessionId, entry, {
      agentId: params.agentId,
      sessionsDir: path.dirname(storePath),
    });
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  await ensureSessionHeader({ sessionFile, sessionId: entry.sessionId });

  const sessionManager = SessionManager.open(sessionFile);

  const mirrorMessage = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: mirrorText }],
    api: "openai-responses" as const,
    provider: "openclaw" as const,
    model: "delivery-mirror" as const,
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
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };

  if (AeonMemoryPlugin) {
    const aeon = AeonMemoryPlugin.getInstance();
    if (aeon && aeon.isAvailable()) {
      aeon.saveTurn(entry.sessionId, mirrorMessage);
    } else {
      sessionManager.appendMessage(mirrorMessage);
    }
  } else {
    sessionManager.appendMessage(mirrorMessage);
  }

  if (!entry.sessionFile || entry.sessionFile !== sessionFile) {
    await updateSessionStore(
      storePath,
      (current) => {
        current[sessionKey] = {
          ...entry,
          sessionFile,
        };
      },
      { activeSessionKey: sessionKey },
    );
  }

  emitSessionTranscriptUpdate(sessionFile);
  return { ok: true, sessionFile };
}
