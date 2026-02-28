/**
 * Session idle nudge sweep — prevents silent hangs after errors.
 *
 * Periodically scans the session store for non-main sessions (subagent,
 * cron, ticket) that have been idle longer than a configurable threshold.
 * For each idle session, triggers a new agent turn with a nudge message
 * prompting the agent to wrap up or continue.
 *
 * Ticket: #71
 */

import fs from "node:fs";
import path from "node:path";
import type { SessionEntry } from "../config/sessions/types.js";
import type { Logger } from "./service/state.js";
import { isEmbeddedPiRunActive } from "../agents/pi-embedded-runner/runs.js";
import { loadSessionStore } from "../config/sessions/store.js";
import { isCronSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";

const DEFAULT_IDLE_NUDGE_MS = 5 * 60_000; // 5 minutes
const MIN_SWEEP_INTERVAL_MS = 60_000; // Don't sweep more than once per minute

const HARDCODED_NUDGE_MESSAGE =
  "This session has been idle for 5 min, if it is over update your files and reply END to prevent this message from repeating.";

/**
 * Load the nudge message from prompts/idle-nudge.md (repo root),
 * falling back to the hardcoded default.
 */
function loadDefaultNudgeMessage(): string {
  try {
    const promptPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../../prompts/idle-nudge.md",
    );
    const text = fs.readFileSync(promptPath, "utf-8").trim();
    if (text) {
      return `[System Message] ${text}`;
    }
  } catch {
    // Fall through
  }
  return `[System Message] ${HARDCODED_NUDGE_MESSAGE}`;
}

let _cachedNudgeMessage: string | undefined;
function getDefaultNudgeMessage(): string {
  if (!_cachedNudgeMessage) {
    _cachedNudgeMessage = loadDefaultNudgeMessage();
  }
  return _cachedNudgeMessage;
}

/** Reset cached message (for tests or after file changes). */
export function resetNudgeMessageCache(): void {
  _cachedNudgeMessage = undefined;
}

/** Maximum nudges per session before giving up. */
const DEFAULT_MAX_NUDGES = 3;

export type IdleNudgeConfig = {
  /** Idle threshold in ms before nudging (default: 300000 = 5 min). */
  idleMs?: number;
  /** Custom nudge message text. */
  message?: string;
  /** Maximum nudges per session (default: 3; 0 = unlimited). */
  maxNudges?: number;
};

export type IdleNudgeSweepResult = {
  swept: boolean;
  nudged: number;
};

/**
 * Resolve idle nudge config from agents.defaults.idleNudge.
 */
export function resolveIdleNudgeConfig(agentDefaults?: {
  idleNudge?: IdleNudgeConfig | boolean | number;
}): IdleNudgeConfig | null {
  const raw = agentDefaults?.idleNudge;
  if (raw === false || raw === 0) {
    return null;
  }
  if (raw === true || raw === undefined) {
    return {
      idleMs: DEFAULT_IDLE_NUDGE_MS,
      message: getDefaultNudgeMessage(),
      maxNudges: DEFAULT_MAX_NUDGES,
    };
  }
  if (typeof raw === "number") {
    return { idleMs: raw, message: getDefaultNudgeMessage(), maxNudges: DEFAULT_MAX_NUDGES };
  }
  return {
    idleMs: raw.idleMs ?? DEFAULT_IDLE_NUDGE_MS,
    message: raw.message ?? getDefaultNudgeMessage(),
    maxNudges: raw.maxNudges ?? DEFAULT_MAX_NUDGES,
  };
}

/** Track nudge counts per session key to enforce maxNudges. */
const nudgeCounts = new Map<string, number>();
let lastSweepAtMs = 0;

/** Reset state (for tests). */
export function resetIdleNudgeState(): void {
  nudgeCounts.clear();
  lastSweepAtMs = 0;
}

/**
 * Returns true if a session key looks like an ephemeral/non-main session
 * that should be nudged when idle.
 */
function isNudgeEligibleSessionKey(sessionKey: string): boolean {
  return (
    isCronSessionKey(sessionKey) ||
    isSubagentSessionKey(sessionKey) ||
    sessionKey.includes(":ticket:")
  );
}

/**
 * Check if the last assistant message in a session transcript ends with "END".
 */
function sessionEndedWithEND(sessionId: string, sessionsDir: string): boolean {
  const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }
  const lines = raw.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "message" || entry.message?.role !== "assistant") {
      continue;
    }
    const c = entry.message.content;
    let text = "";
    if (typeof c === "string") {
      text = c;
    } else if (Array.isArray(c)) {
      for (const block of c) {
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          block.type === "text" &&
          typeof block.text === "string"
        ) {
          text = block.text;
        }
      }
    }
    const trimmed = text.trim();
    return trimmed === "END" || trimmed.endsWith("\nEND");
  }
  return false;
}

/**
 * Sweep the session store for idle non-main sessions and nudge them.
 *
 * Call from the cron timer tick (after sweepCronRunSessions).
 */
export async function sweepIdleSessions(params: {
  sessionStorePath: string;
  /** Directory containing session JSONL transcript files. */
  sessionsDir?: string;
  config: IdleNudgeConfig;
  nowMs?: number;
  log: Logger;
  force?: boolean;
  /** Trigger an isolated agent run on the given session key with the nudge message. */
  nudgeSession: (
    sessionKey: string,
    message: string,
  ) => Promise<{
    status: "ok" | "error" | "skipped";
    error?: string;
  }>;
}): Promise<IdleNudgeSweepResult> {
  const now = params.nowMs ?? Date.now();

  // Throttle
  if (!params.force && now - lastSweepAtMs < MIN_SWEEP_INTERVAL_MS) {
    return { swept: false, nudged: 0 };
  }
  lastSweepAtMs = now;

  const idleMs = params.config.idleMs ?? DEFAULT_IDLE_NUDGE_MS;
  const maxNudges = params.config.maxNudges ?? DEFAULT_MAX_NUDGES;
  const message = params.config.message ?? getDefaultNudgeMessage();
  const cutoff = now - idleMs;

  let store: Record<string, SessionEntry>;
  try {
    store = loadSessionStore(params.sessionStorePath);
  } catch (err) {
    params.log.warn({ err: String(err) }, "idle-nudge: failed to load session store");
    return { swept: false, nudged: 0 };
  }

  const candidates: Array<{ sessionKey: string; entry: SessionEntry }> = [];

  for (const [key, entry] of Object.entries(store)) {
    if (!entry || !entry.sessionId) {
      continue;
    }
    if (!isNudgeEligibleSessionKey(key)) {
      continue;
    }
    if (!entry.updatedAt || entry.updatedAt > cutoff) {
      continue;
    }

    // Skip sessions with an active run — they're working
    if (isEmbeddedPiRunActive(entry.sessionId)) {
      continue;
    }

    // Skip sessions where the agent already said END — they wrapped up
    if (params.sessionsDir && sessionEndedWithEND(entry.sessionId, params.sessionsDir)) {
      continue;
    }

    // Check nudge count
    const count = nudgeCounts.get(key) ?? 0;
    if (maxNudges > 0 && count >= maxNudges) {
      continue;
    }

    candidates.push({ sessionKey: key, entry });
  }

  let nudged = 0;

  for (const { sessionKey, entry } of candidates) {
    try {
      params.log.info(
        { sessionKey, sessionId: entry.sessionId, idleMs: now - (entry.updatedAt ?? 0) },
        "idle-nudge: nudging idle session",
      );
      const result = await params.nudgeSession(sessionKey, message);
      if (result.status === "ok" || result.status === "error") {
        nudgeCounts.set(sessionKey, (nudgeCounts.get(sessionKey) ?? 0) + 1);
        nudged++;
      }
      if (result.status === "error") {
        params.log.warn({ sessionKey, error: result.error }, "idle-nudge: nudge run failed");
      }
    } catch (err) {
      params.log.warn({ sessionKey, err: String(err) }, "idle-nudge: failed to trigger nudge");
    }
  }

  // Clean up nudge counts for sessions that no longer exist
  for (const key of nudgeCounts.keys()) {
    if (!store[key]) {
      nudgeCounts.delete(key);
    }
  }

  if (nudged > 0) {
    params.log.info({ nudged }, `idle-nudge: nudged ${nudged} idle session(s)`);
  }

  return { swept: true, nudged };
}
