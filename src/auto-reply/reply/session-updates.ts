import crypto from "node:crypto";
import { resolveUserTimezone } from "../../agents/date-time.js";
import { buildWorkspaceSkillSnapshot } from "../../agents/skills.js";
import { ensureSkillsWatcher, getSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveMainSessionKey, type SessionEntry, updateSessionStore } from "../../config/sessions.js";
import { buildChannelSummary } from "../../infra/channel-summary.js";
import {
  resolveTimezone,
  formatUtcTimestamp,
  formatZonedTimestamp,
} from "../../infra/format-time/format-datetime.ts";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { drainSystemEventEntries } from "../../infra/system-events.js";

/** Drain queued system events, format as `System:` lines, return the block (or undefined). */
export async function drainFormattedSystemEvents(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  isMainSession: boolean;
  isNewSession: boolean;
}): Promise<string | undefined> {
  const compactSystemEvent = (line: string): string | null => {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }
    const lower = trimmed.toLowerCase();
    if (lower.includes("reason periodic")) {
      return null;
    }
    // Filter out the actual heartbeat prompt, but not cron jobs that mention "heartbeat"
    // The heartbeat prompt starts with "Read HEARTBEAT.md" - cron payloads won't match this
    if (lower.startsWith("read heartbeat.md")) {
      return null;
    }
    // Also filter heartbeat poll/wake noise
    if (lower.includes("heartbeat poll") || lower.includes("heartbeat wake")) {
      return null;
    }
    if (trimmed.startsWith("Node:")) {
      return trimmed.replace(/ · last input [^·]+/i, "").trim();
    }
    return trimmed;
  };

  const resolveSystemEventTimezone = (cfg: OpenClawConfig) => {
    const raw = cfg.agents?.defaults?.envelopeTimezone?.trim();
    if (!raw) {
      return { mode: "local" as const };
    }
    const lowered = raw.toLowerCase();
    if (lowered === "utc" || lowered === "gmt") {
      return { mode: "utc" as const };
    }
    if (lowered === "local" || lowered === "host") {
      return { mode: "local" as const };
    }
    if (lowered === "user") {
      return {
        mode: "iana" as const,
        timeZone: resolveUserTimezone(cfg.agents?.defaults?.userTimezone),
      };
    }
    const explicit = resolveTimezone(raw);
    return explicit ? { mode: "iana" as const, timeZone: explicit } : { mode: "local" as const };
  };

  const formatSystemEventTimestamp = (ts: number, cfg: OpenClawConfig) => {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) {
      return "unknown-time";
    }
    const zone = resolveSystemEventTimezone(cfg);
    if (zone.mode === "utc") {
      return formatUtcTimestamp(date, { displaySeconds: true });
    }
    if (zone.mode === "local") {
      return formatZonedTimestamp(date, { displaySeconds: true }) ?? "unknown-time";
    }
    return (
      formatZonedTimestamp(date, { timeZone: zone.timeZone, displaySeconds: true }) ??
      "unknown-time"
    );
  };

  const systemLines: string[] = [];
  const queued = drainSystemEventEntries(params.sessionKey);
  const mainSessionKey = resolveMainSessionKey(params.cfg);
  if (mainSessionKey !== params.sessionKey) {
    // System-triggered events still enqueue against the canonical main session key.
    // In isolated DM scopes, merge that queue into the active session drain so the
    // currently active DM session can consume those events on its next turn.
    queued.push(...drainSystemEventEntries(mainSessionKey));
  }
  queued.sort((left, right) => left.ts - right.ts);
  systemLines.push(
    ...queued
      .map((event) => {
        const compacted = compactSystemEvent(event.text);
        if (!compacted) {
          return null;
        }
        return `[${formatSystemEventTimestamp(event.ts, params.cfg)}] ${compacted}`;
      })
      .filter((v): v is string => Boolean(v)),
  );
  if (params.isMainSession && params.isNewSession) {
    const summary = await buildChannelSummary(params.cfg);
    if (summary.length > 0) {
      systemLines.unshift(...summary);
    }
  }
  if (systemLines.length === 0) {
    return undefined;
  }

  // Format events as trusted System: lines for the message timeline.
  // Inbound sanitization rewrites any user-supplied "System:" to "System (untrusted):",
  // so these gateway-originated lines are distinguishable by the model.
  // Each sub-line of a multi-line event gets its own System: prefix so continuation
  // lines can't be mistaken for user content.
  return systemLines
    .flatMap((line) => line.split("\n").map((subline) => `System: ${subline}`))
    .join("\n");
}

async function persistSessionEntryUpdate(params: {
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  nextEntry: SessionEntry;
}) {
  if (!params.sessionStore || !params.sessionKey) {
    return;
  }
  params.sessionStore[params.sessionKey] = {
    ...params.sessionStore[params.sessionKey],
    ...params.nextEntry,
  };
  if (!params.storePath) {
    return;
  }
  await updateSessionStore(params.storePath, (store) => {
    store[params.sessionKey!] = { ...store[params.sessionKey!], ...params.nextEntry };
  });
}

export async function ensureSkillSnapshot(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  sessionId?: string;
  isFirstTurnInSession: boolean;
  workspaceDir: string;
  cfg: OpenClawConfig;
  /** If provided, only load skills with these names (for per-channel skill filtering) */
  skillFilter?: string[];
}): Promise<{
  sessionEntry?: SessionEntry;
  skillsSnapshot?: SessionEntry["skillsSnapshot"];
  systemSent: boolean;
}> {
  if (process.env.OPENCLAW_TEST_FAST === "1") {
    // In fast unit-test runs we skip filesystem scanning, watchers, and session-store writes.
    // Dedicated skills tests cover snapshot generation behavior.
    return {
      sessionEntry: params.sessionEntry,
      skillsSnapshot: params.sessionEntry?.skillsSnapshot,
      systemSent: params.sessionEntry?.systemSent ?? false,
    };
  }

  const {
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionId,
    isFirstTurnInSession,
    workspaceDir,
    cfg,
    skillFilter,
  } = params;

  let nextEntry = sessionEntry;
  let systemSent = sessionEntry?.systemSent ?? false;
  const remoteEligibility = getRemoteSkillEligibility();
  const snapshotVersion = getSkillsSnapshotVersion(workspaceDir);
  ensureSkillsWatcher({ workspaceDir, config: cfg });
  const shouldRefreshSnapshot =
    snapshotVersion > 0 && (nextEntry?.skillsSnapshot?.version ?? 0) < snapshotVersion;

  if (isFirstTurnInSession && sessionStore && sessionKey) {
    const current = nextEntry ??
      sessionStore[sessionKey] ?? {
        sessionId: sessionId ?? crypto.randomUUID(),
        updatedAt: Date.now(),
      };
    const skillSnapshot =
      isFirstTurnInSession || !current.skillsSnapshot || shouldRefreshSnapshot
        ? buildWorkspaceSkillSnapshot(workspaceDir, {
            config: cfg,
            skillFilter,
            eligibility: { remote: remoteEligibility },
            snapshotVersion,
          })
        : current.skillsSnapshot;
    nextEntry = {
      ...current,
      sessionId: sessionId ?? current.sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
      systemSent: true,
      skillsSnapshot: skillSnapshot,
    };
    await persistSessionEntryUpdate({ sessionStore, sessionKey, storePath, nextEntry });
    systemSent = true;
  }

  const skillsSnapshot = shouldRefreshSnapshot
    ? buildWorkspaceSkillSnapshot(workspaceDir, {
        config: cfg,
        skillFilter,
        eligibility: { remote: remoteEligibility },
        snapshotVersion,
      })
    : (nextEntry?.skillsSnapshot ??
      (isFirstTurnInSession
        ? undefined
        : buildWorkspaceSkillSnapshot(workspaceDir, {
            config: cfg,
            skillFilter,
            eligibility: { remote: remoteEligibility },
            snapshotVersion,
          })));
  if (
    skillsSnapshot &&
    sessionStore &&
    sessionKey &&
    !isFirstTurnInSession &&
    (!nextEntry?.skillsSnapshot || shouldRefreshSnapshot)
  ) {
    const current = nextEntry ?? {
      sessionId: sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
    };
    nextEntry = {
      ...current,
      sessionId: sessionId ?? current.sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
      skillsSnapshot,
    };
    await persistSessionEntryUpdate({ sessionStore, sessionKey, storePath, nextEntry });
  }

  return { sessionEntry: nextEntry, skillsSnapshot, systemSent };
}

export async function incrementCompactionCount(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  now?: number;
  amount?: number;
  /** Token count after compaction - if provided, updates session token counts */
  tokensAfter?: number;
}): Promise<number | undefined> {
  const {
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    now = Date.now(),
    amount = 1,
    tokensAfter,
  } = params;
  if (!sessionStore || !sessionKey) {
    return undefined;
  }
  const entry = sessionStore[sessionKey] ?? sessionEntry;
  if (!entry) {
    return undefined;
  }
  const incrementBy = Math.max(0, amount);
  const nextCount = (entry.compactionCount ?? 0) + incrementBy;
  // Build update payload with compaction count and optionally updated token counts
  const updates: Partial<SessionEntry> = {
    compactionCount: nextCount,
    updatedAt: now,
  };
  // If tokensAfter is provided, update the cached token counts to reflect post-compaction state
  if (tokensAfter != null && tokensAfter > 0) {
    updates.totalTokens = tokensAfter;
    updates.totalTokensFresh = true;
    // Clear input/output breakdown since we only have the total estimate after compaction
    updates.inputTokens = undefined;
    updates.outputTokens = undefined;
    updates.cacheRead = undefined;
    updates.cacheWrite = undefined;
  }
  sessionStore[sessionKey] = {
    ...entry,
    ...updates,
  };
  if (storePath) {
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        ...store[sessionKey],
        ...updates,
      };
    });
  }
  return nextCount;
}
