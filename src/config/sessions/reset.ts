import { resolveSessionThreadInfo } from "../../channels/plugins/session-conversation.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { SessionConfig, SessionResetConfig } from "../types.base.js";
import { DEFAULT_IDLE_MINUTES } from "./types.js";

export type SessionResetMode = "daily" | "idle";
export type SessionResetType = "direct" | "group" | "thread";

export type SessionResetPolicy = {
  mode: SessionResetMode;
  atHour: number;
  idleMinutes?: number;
  /** IANA timezone for atHour. When set, daily reset boundary is computed in this timezone. */
  timezone?: string;
  /** When true with daily mode, idleMinutes becomes an AND guard (both conditions must be met). */
  idleGuard?: boolean;
};

export type SessionFreshness = {
  fresh: boolean;
  dailyResetAt?: number;
  idleExpiresAt?: number;
};

export const DEFAULT_RESET_MODE: SessionResetMode = "daily";
export const DEFAULT_RESET_AT_HOUR = 4;

const GROUP_SESSION_MARKERS = [":group:", ":channel:"];

export function isThreadSessionKey(sessionKey?: string | null): boolean {
  return Boolean(resolveSessionThreadInfo(sessionKey).threadId);
}

export function resolveSessionResetType(params: {
  sessionKey?: string | null;
  isGroup?: boolean;
  isThread?: boolean;
}): SessionResetType {
  if (params.isThread || isThreadSessionKey(params.sessionKey)) {
    return "thread";
  }
  if (params.isGroup) {
    return "group";
  }
  const normalized = (params.sessionKey ?? "").toLowerCase();
  if (GROUP_SESSION_MARKERS.some((marker) => normalized.includes(marker))) {
    return "group";
  }
  return "direct";
}

export function resolveThreadFlag(params: {
  sessionKey?: string | null;
  messageThreadId?: string | number | null;
  threadLabel?: string | null;
  threadStarterBody?: string | null;
  parentSessionKey?: string | null;
}): boolean {
  if (params.messageThreadId != null) {
    return true;
  }
  if (params.threadLabel?.trim()) {
    return true;
  }
  if (params.threadStarterBody?.trim()) {
    return true;
  }
  if (params.parentSessionKey?.trim()) {
    return true;
  }
  return isThreadSessionKey(params.sessionKey);
}

export function resolveDailyResetAtMs(now: number, atHour: number, timezone?: string): number {
  const normalizedAtHour = normalizeResetAtHour(atHour);
  if (!timezone) {
    // Legacy path: use server-local timezone (original behavior).
    const resetAt = new Date(now);
    resetAt.setHours(normalizedAtHour, 0, 0, 0);
    if (now < resetAt.getTime()) {
      resetAt.setDate(resetAt.getDate() - 1);
    }
    return resetAt.getTime();
  }

  // Timezone-aware path: compute the most recent occurrence of atHour in the
  // given IANA timezone.
  const { year, month, day } = getWallClockDate(now, timezone);
  const candidateToday = wallClockToEpochMs(year, month, day, normalizedAtHour, timezone);
  if (candidateToday <= now) {
    return candidateToday;
  }
  // atHour hasn't occurred yet today in the target timezone → use yesterday.
  const { year: y2, month: m2, day: d2 } = getWallClockDate(now - 86_400_000, timezone);
  return wallClockToEpochMs(y2, m2, d2, normalizedAtHour, timezone);
}

export function resolveSessionResetPolicy(params: {
  sessionCfg?: SessionConfig;
  resetType: SessionResetType;
  resetOverride?: SessionResetConfig;
  /** Fallback timezone when reset config doesn't specify one (e.g. agents.defaults.userTimezone). */
  userTimezone?: string;
}): SessionResetPolicy {
  const sessionCfg = params.sessionCfg;
  const baseReset = params.resetOverride ?? sessionCfg?.reset;
  // Backward compat: accept legacy "dm" key as alias for "direct"
  const typeReset = params.resetOverride
    ? undefined
    : (sessionCfg?.resetByType?.[params.resetType] ??
      (params.resetType === "direct"
        ? (sessionCfg?.resetByType as { dm?: SessionResetConfig } | undefined)?.dm
        : undefined));
  const hasExplicitReset = Boolean(baseReset || sessionCfg?.resetByType);
  const legacyIdleMinutes = params.resetOverride ? undefined : sessionCfg?.idleMinutes;
  const mode =
    typeReset?.mode ??
    baseReset?.mode ??
    (!hasExplicitReset && legacyIdleMinutes != null ? "idle" : DEFAULT_RESET_MODE);
  const atHour = normalizeResetAtHour(
    typeReset?.atHour ?? baseReset?.atHour ?? DEFAULT_RESET_AT_HOUR,
  );
  const idleMinutesRaw = typeReset?.idleMinutes ?? baseReset?.idleMinutes ?? legacyIdleMinutes;

  let idleMinutes: number | undefined;
  if (idleMinutesRaw != null) {
    const normalized = Math.floor(idleMinutesRaw);
    if (Number.isFinite(normalized)) {
      idleMinutes = Math.max(normalized, 0);
    }
  } else if (mode === "idle") {
    idleMinutes = DEFAULT_IDLE_MINUTES;
  }

  const timezone =
    (typeReset?.timezone ?? baseReset?.timezone ?? params.userTimezone)?.trim() || undefined;
  const idleGuard = typeReset?.idleGuard ?? baseReset?.idleGuard ?? false;

  return { mode, atHour, idleMinutes, timezone, idleGuard };
}

export function resolveChannelResetConfig(params: {
  sessionCfg?: SessionConfig;
  channel?: string | null;
}): SessionResetConfig | undefined {
  const resetByChannel = params.sessionCfg?.resetByChannel;
  if (!resetByChannel) {
    return undefined;
  }
  const normalized = normalizeMessageChannel(params.channel);
  const fallback = params.channel?.trim().toLowerCase();
  const key = normalized ?? fallback;
  if (!key) {
    return undefined;
  }
  return resetByChannel[key] ?? resetByChannel[key.toLowerCase()];
}

export function evaluateSessionFreshness(params: {
  updatedAt: number;
  now: number;
  policy: SessionResetPolicy;
}): SessionFreshness {
  const dailyResetAt =
    params.policy.mode === "daily"
      ? resolveDailyResetAtMs(params.now, params.policy.atHour, params.policy.timezone)
      : undefined;
  const idleExpiresAt =
    params.policy.idleMinutes != null && params.policy.idleMinutes > 0
      ? params.updatedAt + params.policy.idleMinutes * 60_000
      : undefined;
  const staleDaily = dailyResetAt != null && params.updatedAt < dailyResetAt;
  const staleIdle = idleExpiresAt != null && params.now > idleExpiresAt;

  let stale: boolean;
  if (
    params.policy.idleGuard &&
    params.policy.mode === "daily" &&
    dailyResetAt != null &&
    idleExpiresAt != null
  ) {
    // AND mode: both daily boundary AND idle window must be exceeded.
    stale = staleDaily && staleIdle;
  } else {
    // Default OR mode: either condition triggers reset.
    stale = staleDaily || staleIdle;
  }

  return {
    fresh: !stale,
    dailyResetAt,
    idleExpiresAt,
  };
}

//#region timezone helpers

/** Extract wall-clock date components in a given IANA timezone. */
function getWallClockDate(
  epochMs: number,
  timezone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochMs));
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") {
      map[p.type] = p.value;
    }
  }
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

/**
 * Convert a wall-clock date+hour in an IANA timezone to epoch ms.
 * Uses an offset-estimation approach with one refinement pass to handle DST edges.
 */
function wallClockToEpochMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  timezone: string,
): number {
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:00:00`;
  const utcGuess = Date.parse(iso + "Z");

  // First pass: compute offset at the guess point, then refine.
  const offset1 = computeTzOffsetMs(utcGuess, timezone);
  const result1 = utcGuess - offset1;
  const offset2 = computeTzOffsetMs(result1, timezone);
  if (offset1 === offset2) {
    return result1;
  }
  // DST edge: re-apply with the refined offset.
  return utcGuess - offset2;
}

/**
 * Compute the UTC offset (in ms) for a timezone at a given epoch.
 * Positive means ahead of UTC (e.g. +8h for Asia/Shanghai).
 */
function computeTzOffsetMs(epochMs: number, timezone: string): number {
  const d = new Date(epochMs);
  const utcH = d.getUTCHours();
  const utcM = d.getUTCMinutes();
  const utcDay = d.getUTCDate();

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") {
      map[p.type] = p.value;
    }
  }

  let diffMinutes =
    (Number(map.day) - utcDay) * 1440 +
    (Number(map.hour) - utcH) * 60 +
    (Number(map.minute) - utcM);
  // Handle month boundary (e.g., tz day=1, utc day=31).
  if (diffMinutes > 720) {
    diffMinutes -= 1440;
  }
  if (diffMinutes < -720) {
    diffMinutes += 1440;
  }

  return diffMinutes * 60_000;
}

//#endregion

function normalizeResetAtHour(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_RESET_AT_HOUR;
  }
  const normalized = Math.floor(value);
  if (!Number.isFinite(normalized)) {
    return DEFAULT_RESET_AT_HOUR;
  }
  if (normalized < 0) {
    return 0;
  }
  if (normalized > 23) {
    return 23;
  }
  return normalized;
}
