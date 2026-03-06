import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { resolveDefaultSessionStorePath } from "./paths.js";
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

type CliTurnUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

const ZERO_USAGE = {
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
};

export type SessionTranscriptMessageMeta = {
  channel?: string;
  accountId?: string;
  chatId?: string;
  chatType?: "direct" | "group";
  providerMessageId?: string;
  providerMessageIds?: string[];
  parentId?: string;
  threadId?: string | number;
};

function normalizeNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.max(0, Math.floor(value));
  return normalized;
}

function buildCliUsage(usage?: CliTurnUsage): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
} | null {
  if (!usage) {
    return null;
  }
  const input = normalizeNonNegativeNumber(usage.input) ?? 0;
  const output = normalizeNonNegativeNumber(usage.output) ?? 0;
  const cacheRead = normalizeNonNegativeNumber(usage.cacheRead) ?? 0;
  const cacheWrite = normalizeNonNegativeNumber(usage.cacheWrite) ?? 0;
  const totalTokens =
    normalizeNonNegativeNumber(usage.total) ?? input + output + cacheRead + cacheWrite;
  const hasUsage = totalTokens > 0 || input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0;
  if (!hasUsage) {
    return null;
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export async function appendCliTurnToSessionTranscript(params: {
  sessionFile: string;
  sessionId: string;
  userText?: string;
  assistantText?: string;
  provider: string;
  model: string;
  usage?: CliTurnUsage;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const sessionFile = params.sessionFile.trim();
  if (!sessionFile) {
    return { ok: false, reason: "missing sessionFile" };
  }
  const sessionId = params.sessionId.trim();
  if (!sessionId) {
    return { ok: false, reason: "missing sessionId" };
  }
  const userText = params.userText?.trim() ?? "";
  const assistantText = params.assistantText?.trim() ?? "";
  if (!userText && !assistantText) {
    return { ok: false, reason: "empty turn" };
  }

  await ensureSessionHeader({ sessionFile, sessionId });

  const sessionManager = SessionManager.open(sessionFile);
  if (userText) {
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now(),
    });
  }
  if (assistantText) {
    const usage = buildCliUsage(params.usage) ?? ZERO_USAGE;
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: assistantText }],
      api: "cli",
      provider: params.provider,
      model: params.model,
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    });
  }
  emitSessionTranscriptUpdate(sessionFile);
  return { ok: true };
}

export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  text?: string;
  mediaUrls?: string[];
  messageMeta?: SessionTranscriptMessageMeta;
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

  const sessionManager = SessionManager.open(sessionFile);
  // Save current leafId before appending delivery-mirror
  // This prevents delivery-mirror from affecting the main chain (leafId)
  const savedLeafId = sessionManager.getLeafId();
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
    ...(params.messageMeta ? { openclawMessageMeta: params.messageMeta } : {}),
  });
  // Restore leafId so delivery-mirror doesn't affect the main chain.
  // branch() only updates in-memory leafId; on next SessionManager.open(),
  // _buildIndex() would set leafId to the delivery-mirror entry (last in JSONL).
  // branchWithSummary() persists a branch_summary entry to JSONL, so _buildIndex()
  // picks it up as leafId. buildSessionContext() walks from its parentId (savedLeafId),
  // skipping delivery-mirror. Empty summary is filtered by the "entry.summary" guard.
  if (savedLeafId !== null) {
    sessionManager.branchWithSummary(savedLeafId, "", undefined, false);
  }

  emitSessionTranscriptUpdate(sessionFile);
  return { ok: true, sessionFile };
}
