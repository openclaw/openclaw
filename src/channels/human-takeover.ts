import type { HumanTakeoverConfig } from "../config/types.base.js";

const DEFAULT_HUMAN_TAKEOVER_COOLDOWN_SECONDS = 300;
const HUMAN_TAKEOVER_MAX_TRACKED_SESSIONS = 5000;
const humanTakeoverCooldownBySession = new Map<string, number>();

function pruneHumanTakeoverState(nowMs: number): void {
  for (const [sessionKey, activeUntil] of humanTakeoverCooldownBySession) {
    if (activeUntil <= nowMs) {
      humanTakeoverCooldownBySession.delete(sessionKey);
    }
  }

  if (humanTakeoverCooldownBySession.size <= HUMAN_TAKEOVER_MAX_TRACKED_SESSIONS) {
    return;
  }

  const overflow = humanTakeoverCooldownBySession.size - HUMAN_TAKEOVER_MAX_TRACKED_SESSIONS;
  const oldestByExpiry = [...humanTakeoverCooldownBySession.entries()]
    .toSorted((a, b) => a[1] - b[1])
    .slice(0, overflow);
  for (const [sessionKey] of oldestByExpiry) {
    humanTakeoverCooldownBySession.delete(sessionKey);
  }
}

export type ResolvedHumanTakeoverConfig = {
  enabled: boolean;
  cooldownMs: number;
};

export type HumanTakeoverDecision = {
  skipAutoReply: boolean;
  activated: boolean;
  reason?: "owner-message" | "cooldown-active";
  remainingMs?: number;
};

export function resolveHumanTakeoverConfig(params: {
  channelConfig?: { humanTakeover?: HumanTakeoverConfig } | null;
  accountConfig?: { humanTakeover?: HumanTakeoverConfig } | null;
  defaultCooldownSeconds?: number;
}): ResolvedHumanTakeoverConfig {
  const configured = params.accountConfig?.humanTakeover ?? params.channelConfig?.humanTakeover;
  const enabled = configured?.enabled === true;
  const cooldownSecondsRaw =
    configured?.cooldownSeconds ??
    params.defaultCooldownSeconds ??
    DEFAULT_HUMAN_TAKEOVER_COOLDOWN_SECONDS;
  const cooldownSeconds =
    Number.isFinite(cooldownSecondsRaw) && cooldownSecondsRaw > 0
      ? Math.floor(cooldownSecondsRaw)
      : DEFAULT_HUMAN_TAKEOVER_COOLDOWN_SECONDS;

  return {
    enabled,
    cooldownMs: cooldownSeconds * 1000,
  };
}

export function decideHumanTakeover(params: {
  sessionKey: string;
  enabled: boolean;
  cooldownMs: number;
  isOwnerMessage: boolean;
  isCommandLike?: boolean;
  nowMs?: number;
}): HumanTakeoverDecision {
  if (!params.sessionKey || !params.enabled || params.cooldownMs <= 0) {
    return { skipAutoReply: false, activated: false };
  }

  const nowMs = params.nowMs ?? Date.now();
  pruneHumanTakeoverState(nowMs);

  if (params.isOwnerMessage) {
    if (params.isCommandLike) {
      return { skipAutoReply: false, activated: false };
    }
    const nextActiveUntil = nowMs + params.cooldownMs;
    humanTakeoverCooldownBySession.set(params.sessionKey, nextActiveUntil);
    pruneHumanTakeoverState(nowMs);
    return {
      skipAutoReply: true,
      activated: true,
      reason: "owner-message",
      remainingMs: params.cooldownMs,
    };
  }

  const cooldownUntil = humanTakeoverCooldownBySession.get(params.sessionKey) ?? 0;
  if (cooldownUntil > nowMs) {
    return {
      skipAutoReply: true,
      activated: false,
      reason: "cooldown-active",
      remainingMs: cooldownUntil - nowMs,
    };
  }

  return { skipAutoReply: false, activated: false };
}

export function resetHumanTakeoverState(): void {
  humanTakeoverCooldownBySession.clear();
}
