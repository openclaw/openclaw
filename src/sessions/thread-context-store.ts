/**
 * Thread Context Store — cross-session context for IM threads (issue #50556).
 *
 * When a cron job (or any isolated-agent run) delivers a message to a channel
 * thread, it can store a lightweight context record here. When the next session
 * in the same thread starts (e.g., a user replies), the stored context is
 * injected into the session prompt so the agent knows what task triggered the
 * thread and what the previous run produced.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { writeJsonAtomic } from "../infra/json-files.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("sessions/thread-context-store");

/** Maximum number of context entries kept per store file (rolling window). */
export const MAX_THREAD_CONTEXT_ENTRIES = 200;
/** Maximum age (ms) before an entry is considered stale and pruned. */
export const THREAD_CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days

export type ThreadContextEntry = {
  /** Unique key: `channel:accountId:threadId` */
  threadKey: string;
  /** Session key from the run that created this context. */
  sessionKey: string;
  /** Short summary of what the run accomplished (≤ 1 000 chars). */
  summary: string;
  /** The original task / cron job prompt (≤ 500 chars). */
  task: string;
  /** When this context was saved (epoch ms). */
  savedAt: number;
};

type ThreadContextStore = Record<string, ThreadContextEntry>;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function resolveThreadContextStorePath(stateDir: string = resolveStateDir()): string {
  return path.join(stateDir, "sessions", "thread-contexts.json");
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

async function loadThreadContextStore(storePath: string): Promise<ThreadContextStore> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ThreadContextStore;
    }
  } catch {
    // File absent or corrupt — start fresh.
  }
  return {};
}

function pruneThreadContextStore(store: ThreadContextStore, nowMs: number): ThreadContextStore {
  const ttlCutoff = nowMs - THREAD_CONTEXT_TTL_MS;
  const entries = Object.values(store).filter((e) => e.savedAt >= ttlCutoff);
  // Keep newest entries if we exceed the hard cap.
  entries.sort((a, b) => b.savedAt - a.savedAt);
  const kept = entries.slice(0, MAX_THREAD_CONTEXT_ENTRIES);
  const result: ThreadContextStore = {};
  for (const e of kept) {
    result[e.threadKey] = e;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the canonical thread key for a given channel / account / chat / thread tuple.
 *
 * `threadId` alone is not globally unique — for providers like Telegram it is
 * a topic ID scoped to a specific chat, so two chats on the same account can
 * share the same topic ID. Including `chatId` (the conversation/group ID)
 * makes the key unambiguous.
 */
export function buildThreadContextKey(params: {
  channel: string;
  accountId?: string | null;
  chatId?: string | null;
  threadId: string | number;
}): string {
  const channel = params.channel.trim().toLowerCase() || "unknown";
  const accountId = (params.accountId ?? "default").trim().toLowerCase() || "default";
  const chatId = (params.chatId ?? "default").trim().toLowerCase() || "default";
  return `${channel}:${accountId}:${chatId}:${String(params.threadId)}`;
}

/**
 * Persist a context record for a thread. Called after a cron run successfully
 * delivers a message to a thread-style conversation.
 */
export async function saveThreadContext(
  params: {
    channel: string;
    accountId?: string | null;
    chatId?: string | null;
    threadId: string | number;
    sessionKey: string;
    summary: string;
    task: string;
  },
  stateDir?: string,
): Promise<void> {
  const storePath = resolveThreadContextStorePath(stateDir);
  const nowMs = Date.now();
  const threadKey = buildThreadContextKey({
    channel: params.channel,
    accountId: params.accountId,
    chatId: params.chatId,
    threadId: params.threadId,
  });

  const summary = params.summary.slice(0, 1_000);
  const task = params.task.slice(0, 500);

  const entry: ThreadContextEntry = {
    threadKey,
    sessionKey: params.sessionKey,
    summary,
    task,
    savedAt: nowMs,
  };

  try {
    const store = await loadThreadContextStore(storePath);
    // Add the new entry first, then prune so the new entry is always kept.
    store[threadKey] = entry;
    const pruned = pruneThreadContextStore(store, nowMs);
    await writeJsonAtomic(storePath, pruned);
    log.info(`thread-context saved: ${threadKey}`);
  } catch (err) {
    log.warn(
      `thread-context: failed to save for ${threadKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Load the most recent context entry for a thread. Returns `undefined` when no
 * context exists or when the stored entry is stale.
 */
export async function loadThreadContext(
  params: {
    channel: string;
    accountId?: string | null;
    chatId?: string | null;
    threadId: string | number;
  },
  stateDir?: string,
): Promise<ThreadContextEntry | undefined> {
  const storePath = resolveThreadContextStorePath(stateDir);
  const threadKey = buildThreadContextKey(params);
  try {
    const store = await loadThreadContextStore(storePath);
    const entry = store[threadKey];
    if (!entry) {
      return undefined;
    }
    const age = Date.now() - entry.savedAt;
    if (age > THREAD_CONTEXT_TTL_MS) {
      return undefined;
    }
    return entry;
  } catch {
    return undefined;
  }
}

/**
 * Format thread context as a human-readable block suitable for injection into
 * the agent's system prompt or user message prefix.
 */
export function formatThreadContextNote(entry: ThreadContextEntry): string {
  const lines: string[] = ["[Prior session context for this thread]"];
  if (entry.task) {
    lines.push(`Task: ${entry.task}`);
  }
  if (entry.summary) {
    lines.push(`Result: ${entry.summary}`);
  }
  return lines.join("\n");
}
