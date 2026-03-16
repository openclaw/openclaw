import fs from "node:fs/promises";
import path from "node:path";
import { inferSessionReplyLanguage } from "./session-language.js";

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

const MAX_DELIVERED_NOTES = 20;
const MAX_NOTE_LENGTH = 96;
const OAG_STATE_LOCK_SUFFIX = ".lock";
const OAG_STATE_LOCK_RETRY_MS = 25;
const OAG_STATE_LOCK_TIMEOUT_MS = 2_000;
const OAG_STATE_LOCK_STALE_MS = 30_000;
const OAG_STATE_LOCK_PID_FILE = "pid";

function resolveLocalizedOagMessage(note: OagPendingUserNote, language?: "zh-Hans" | "en"): string {
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

async function isLockStale(lockPath: string): Promise<boolean> {
  const pidPath = path.join(lockPath, OAG_STATE_LOCK_PID_FILE);
  try {
    const content = await fs.readFile(pidPath, "utf8");
    const pid = Number.parseInt(content.trim(), 10);
    if (Number.isNaN(pid) || pid <= 0) {
      return true;
    }
    try {
      // Signal 0 checks if the process exists without sending a signal.
      process.kill(pid, 0);
      // Process exists — check lock age as a fallback safety net.
      const stat = await fs.stat(pidPath);
      return Date.now() - stat.mtimeMs > OAG_STATE_LOCK_STALE_MS;
    } catch {
      // Process does not exist — lock is stale.
      return true;
    }
  } catch {
    // No PID file — treat as stale (legacy lock from before this fix).
    return true;
  }
}

async function withOagStateLock<T>(statePath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${statePath}${OAG_STATE_LOCK_SUFFIX}`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + OAG_STATE_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") {
        throw error;
      }
      if (await isLockStale(lockPath)) {
        await fs.rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring OAG state lock for ${statePath}`, { cause: error });
      }
      await sleep(OAG_STATE_LOCK_RETRY_MS);
    }
  }
  // Write PID file so other processes can detect stale locks.
  try {
    await fs.writeFile(path.join(lockPath, OAG_STATE_LOCK_PID_FILE), String(process.pid), "utf8");
  } catch {
    // Best-effort — the lock itself is still held via the directory.
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
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
    ].slice(-MAX_DELIVERED_NOTES);
    await fs.writeFile(path, JSON.stringify(parsed, null, 2) + "\n", "utf8");
    return consumed;
  });
  if (matched.length === 0) {
    return [];
  }
  const sorted = matched
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
  return results;
}
