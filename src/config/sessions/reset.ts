import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { SessionConfig, SessionResetConfig } from "../types.base.js";
import { DEFAULT_IDLE_MINUTES } from "./types.js";

export type SessionResetMode = "daily" | "idle";
export type SessionResetType = "direct" | "group" | "thread";

export type SessionResetPolicy = {
  mode: SessionResetMode;
  atHour: number;
  idleMinutes?: number;
};

export type SessionFreshness = {
  fresh: boolean;
  dailyResetAt?: number;
  idleExpiresAt?: number;
};

export const DEFAULT_RESET_MODE: SessionResetMode = "daily";
export const DEFAULT_RESET_AT_HOUR = 4;

/**
 * Default idle timeout for group and thread sessions when no explicit reset
 * policy is configured. 7 days (10080 minutes) — long enough to survive a
 * weekend without losing context, but still expires stale threads eventually.
 */
export const DEFAULT_GROUP_THREAD_IDLE_MINUTES = 10080;

const THREAD_SESSION_MARKERS = [":thread:", ":topic:"];
const GROUP_SESSION_MARKERS = [":group:", ":channel:"];

export function isThreadSessionKey(sessionKey?: string | null): boolean {
  const normalized = (sessionKey ?? "").toLowerCase();
  if (!normalized) {
    return false;
  }
  return THREAD_SESSION_MARKERS.some((marker) => normalized.includes(marker));
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

export function resolveDailyResetAtMs(now: number, atHour: number): number {
  const normalizedAtHour = normalizeResetAtHour(atHour);
  const resetAt = new Date(now);
  resetAt.setHours(normalizedAtHour, 0, 0, 0);
  if (now < resetAt.getTime()) {
    resetAt.setDate(resetAt.getDate() - 1);
  }
  return resetAt.getTime();
}

export function resolveSessionResetPolicy(params: {
  sessionCfg?: SessionConfig;
  resetType: SessionResetType;
  resetOverride?: SessionResetConfig;
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

  // Group and thread sessions default to idle mode when no explicit policy is
  // configured. Daily resets are disruptive for ongoing group conversations and
  // forum topics — they wipe context overnight even for active threads.
  // See: github.com/openclaw/openclaw/issues/32109
  const isGroupOrThread =
    params.resetType === "group" || params.resetType === "thread";
  const impliedDefaultMode: SessionResetMode =
    !hasExplicitReset && isGroupOrThread ? "idle" : DEFAULT_RESET_MODE;

  const mode =
    typeReset?.mode ??
    baseReset?.mode ??
    (!hasExplicitReset && legacyIdleMinutes != null ? "idle" : impliedDefaultMode);
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
    // Group/thread sessions get a 7-day idle window by default; direct sessions
    // keep the legacy DEFAULT_IDLE_MINUTES (0 = no idle expiry beyond daily reset).
    idleMinutes = isGroupOrThread ? DEFAULT_GROUP_THREAD_IDLE_MINUTES : DEFAULT_IDLE_MINUTES;
  }

  return { mode, atHour, idleMinutes };
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
      ? resolveDailyResetAtMs(params.now, params.policy.atHour)
      : undefined;
  const idleExpiresAt =
    params.policy.idleMinutes != null && params.policy.idleMinutes > 0
      ? params.updatedAt + params.policy.idleMinutes * 60_000
      : undefined;
  const staleDaily = dailyResetAt != null && params.updatedAt < dailyResetAt;
  const staleIdle = idleExpiresAt != null && params.now > idleExpiresAt;
  return {
    fresh: !(staleDaily || staleIdle),
    dailyResetAt,
    idleExpiresAt,
  };
}

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
