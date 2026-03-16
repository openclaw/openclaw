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

function resolveLocalizedOagMessage(note: OagPendingUserNote, language?: "zh-Hans" | "en"): string {
  const fallback = String(note.message ?? "").trim();
  if (language !== "en") {
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
      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring OAG state lock for ${statePath}`, { cause: error });
      }
      await sleep(OAG_STATE_LOCK_RETRY_MS);
    }
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
  const latest = matched
    .slice()
    .toSorted((left, right) => resolveNoteTimestamp(right) - resolveNoteTimestamp(left))[0];
  if (!latest) {
    return [];
  }
  const message = normalizeNoteMessage(resolveLocalizedOagMessage(latest, replyLanguage));
  if (!message) {
    return [];
  }
  const timestamp = resolveNoteTimestamp(latest);
  return [
    {
      text: `OAG: ${message}`,
      ts: timestamp > 0 ? timestamp : Date.now(),
    },
  ];
}
