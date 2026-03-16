import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import {
  resolveOagLockStaleMs,
  resolveOagLockTimeoutMs,
  resolveOagMaxDeliveredNotes,
  resolveOagNoteDedupWindowMs,
} from "./oag-config.js";
import { incrementOagMetric } from "./oag-metrics.js";
import { inferSessionReplyLanguage, type SessionReplyLanguage } from "./session-language.js";

type OagNoteTarget = {
  sessionKeys?: string[];
};

type OagPendingUserNote = {
  action?: string;
  id?: string;
  created_at?: string;
  message?: string;
  targets?: OagNoteTarget[];
  delivered_at?: string;
  delivered_session_key?: string;
};

type OagChannelHealthState = {
  pending_user_notes?: OagPendingUserNote[];
  delivered_user_notes?: OagPendingUserNote[];
};

const MAX_NOTE_LENGTH = 96;
const OAG_STATE_LOCK_SUFFIX = ".lock";
const OAG_STATE_LOCK_RETRY_MS = 25;

function resolveLocalizedOagMessage(
  note: OagPendingUserNote,
  language?: SessionReplyLanguage,
): string {
  const fallback = String(note.message ?? "").trim();
  if (language === "zh-Hans") {
    return fallback;
  }
  switch (note.action) {
    case "recovery_verify":
      return "I ran a recovery check for a channel that did not recover cleanly.";
    case "gateway_restart_triggered":
      return "I restarted the message gateway to clear lingering channel backlog.";
    case "gateway_restart_failed":
      return "I attempted gateway recovery, but the restart failed. Monitoring continues.";
    case "channel_backlog_cleared":
    case "channel_congestion_cleared":
    case "channel_escalation_cleared":
      return "Channel backlog cleared and delivery resumed.";
    case "channel_watch_note":
      return "I paused extra follow-ups until the affected channel recovers.";
    default:
      return fallback;
  }
}

function getOagChannelHealthPath(): string | undefined {
  const home = process.env.HOME?.trim();
  return home ? `${home}/.openclaw/sentinel/channel-health-state.json` : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function isLockStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const content = await fs.readFile(lockPath, "utf8");
    const lines = content.trim().split("\n");
    const pid = Number.parseInt(lines[0] ?? "", 10);
    if (Number.isNaN(pid) || pid <= 0) {
      return true;
    }
    try {
      // Signal 0 checks if the process exists without sending a signal.
      process.kill(pid, 0);
      // Process exists — check lock age as a fallback safety net.
      const stat = await fs.stat(lockPath);
      return Date.now() - stat.mtimeMs > staleMs;
    } catch {
      // Process does not exist — lock is stale.
      return true;
    }
  } catch {
    // No lock file content — treat as stale.
    return true;
  }
}

async function withOagStateLock<T>(statePath: string, fn: () => Promise<T>): Promise<T> {
  const cfg = loadConfig();
  const lockTimeoutMs = resolveOagLockTimeoutMs(cfg);
  const lockStaleMs = resolveOagLockStaleMs(cfg);
  const lockPath = `${statePath}${OAG_STATE_LOCK_SUFFIX}`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + lockTimeoutMs;
  let fd: import("node:fs/promises").FileHandle | null = null;
  while (true) {
    try {
      // "wx" = O_CREAT | O_EXCL | O_WRONLY — atomic create, fails if file exists.
      fd = await fs.open(lockPath, "wx");
      incrementOagMetric("lockAcquisitions");
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") {
        throw error;
      }
      if (await isLockStale(lockPath, lockStaleMs)) {
        await fs.unlink(lockPath).catch(() => {});
        incrementOagMetric("lockStalRecoveries");
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring OAG state lock for ${statePath}`, { cause: error });
      }
      await sleep(OAG_STATE_LOCK_RETRY_MS);
    }
  }
  try {
    // Write PID into the lock file so other processes can detect stale locks.
    await fd.writeFile(String(process.pid), "utf8");
    return await fn();
  } finally {
    await fd.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
  }
}

function normalizeNoteMessage(message?: string): string {
  const cleaned = String(message ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "";
  }
  if (cleaned.length <= MAX_NOTE_LENGTH) {
    return cleaned;
  }
  return `${cleaned.slice(0, MAX_NOTE_LENGTH - 1).trimEnd()}…`;
}

function noteMatchesSession(note: OagPendingUserNote, sessionKey: string): boolean {
  const loweredSessionKey = sessionKey.trim().toLowerCase();
  if (!loweredSessionKey) {
    return false;
  }
  const targets = Array.isArray(note.targets) ? note.targets : [];
  return targets.some(
    (target) =>
      Array.isArray(target?.sessionKeys || (target as { session_keys?: string[] }).session_keys) &&
      (target.sessionKeys || (target as { session_keys?: string[] }).session_keys || []).some(
        (candidate) => candidate.trim().toLowerCase() === loweredSessionKey,
      ),
  );
}

function resolveNoteTimestamp(note: OagPendingUserNote): number {
  const parsed = Date.parse(note.created_at ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

function deduplicateNotesByAction(
  notes: OagPendingUserNote[],
  dedupWindowMs: number,
): OagPendingUserNote[] {
  if (notes.length <= 1) {
    return notes;
  }
  // Notes without a non-empty action are never deduplicated — each is a distinct event.
  const withAction: OagPendingUserNote[] = [];
  const withoutAction: OagPendingUserNote[] = [];
  for (const note of notes) {
    if (note.action?.trim()) {
      withAction.push(note);
    } else {
      withoutAction.push(note);
    }
  }
  if (withAction.length === 0) {
    return notes;
  }
  const grouped = new Map<string, OagPendingUserNote[]>();
  for (const note of withAction) {
    const key = note.action as string;
    const group = grouped.get(key);
    if (group) {
      group.push(note);
    } else {
      grouped.set(key, [note]);
    }
  }
  const result: OagPendingUserNote[] = [...withoutAction];
  for (const [, group] of grouped) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    // Sort by timestamp descending to find the most recent
    group.sort((a, b) => resolveNoteTimestamp(b) - resolveNoteTimestamp(a));
    const newest = group[0];
    const newestTs = resolveNoteTimestamp(newest);
    // Only deduplicate notes within the time window of the newest
    const deduped = group.filter(
      (note) => note === newest || newestTs - resolveNoteTimestamp(note) > dedupWindowMs,
    );
    result.push(...deduped);
  }
  // Re-sort ascending by timestamp for consistent output
  result.sort((a, b) => resolveNoteTimestamp(a) - resolveNoteTimestamp(b));
  return result;
}

export async function consumePendingOagSystemNotes(sessionKey: string): Promise<
  Array<{
    text: string;
    ts: number;
  }>
> {
  const path = getOagChannelHealthPath();
  const normalizedSessionKey = sessionKey.trim();
  if (!path || !normalizedSessionKey) {
    return [];
  }
  const replyLanguage = await inferSessionReplyLanguage({ sessionKey: normalizedSessionKey });
  const matched = await withOagStateLock(path, async () => {
    let parsed: OagChannelHealthState;
    try {
      parsed = JSON.parse(await fs.readFile(path, "utf8")) as OagChannelHealthState;
    } catch {
      return [];
    }
    const pending = Array.isArray(parsed.pending_user_notes) ? parsed.pending_user_notes : [];
    if (pending.length === 0) {
      return [];
    }
    const consumed: OagPendingUserNote[] = [];
    const remaining: OagPendingUserNote[] = [];
    for (const note of pending) {
      if (noteMatchesSession(note, normalizedSessionKey)) {
        consumed.push(note);
      } else {
        remaining.push(note);
      }
    }
    if (consumed.length === 0) {
      return [];
    }
    const deliveredAt = new Date().toISOString();
    const deliveredHistory = Array.isArray(parsed.delivered_user_notes)
      ? parsed.delivered_user_notes
      : [];
    parsed.pending_user_notes = remaining;
    parsed.delivered_user_notes = [
      ...deliveredHistory,
      ...consumed.map((note) => ({
        ...note,
        delivered_at: deliveredAt,
        delivered_session_key: normalizedSessionKey,
      })),
    ].slice(-resolveOagMaxDeliveredNotes(loadConfig()));
    await fs.writeFile(path, JSON.stringify(parsed, null, 2) + "\n", "utf8");
    return consumed;
  });
  if (matched.length === 0) {
    return [];
  }
  const deduplicated = deduplicateNotesByAction(matched, resolveOagNoteDedupWindowMs(loadConfig()));
  if (matched.length - deduplicated.length > 0) {
    incrementOagMetric("noteDeduplications", matched.length - deduplicated.length);
  }
  const sorted = deduplicated
    .slice()
    .toSorted((left, right) => resolveNoteTimestamp(left) - resolveNoteTimestamp(right));
  const results: Array<{ text: string; ts: number }> = [];
  for (const note of sorted) {
    const message = normalizeNoteMessage(resolveLocalizedOagMessage(note, replyLanguage));
    if (!message) {
      continue;
    }
    const timestamp = resolveNoteTimestamp(note);
    results.push({
      text: `OAG: ${message}`,
      ts: timestamp > 0 ? timestamp : Date.now(),
    });
  }
  if (results.length > 0) {
    incrementOagMetric("noteDeliveries", results.length);
  }
  return results;
}
