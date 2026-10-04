// Targeted and broadcast wakes share cooldown policy to prevent tool-exit feedback loops.
import type { HeartbeatWakeIntent } from "./heartbeat-wake.js";

const DEFAULT_MIN_WAKE_SPACING_MS = 30_000;
const DEFAULT_FLOOD_WINDOW_MS = 60_000;
const DEFAULT_FLOOD_THRESHOLD = 5;

export type DeferDecision =
  | { defer: false }
  | {
      defer: true;
      reason: "not-due" | "min-spacing" | "flood";
      /** First wall-clock instant at which this guard can admit the wake. */
      retryAtMs: number;
    };

type ShouldDeferInput = {
  intent: HeartbeatWakeIntent;
  now: number;
  /** When this agent's next interval-tick run is due. */
  nextDueMs: number;
  lastRunStartedAtMs?: number;
  recentRunStarts?: readonly number[];
  /** Work already retained by the wake queue after a prior guard deferral. */
  retainedWork?: boolean;
};

export function shouldDeferWake(input: ShouldDeferInput): DeferDecision {
  if (input.intent === "manual") {
    return { defer: false };
  }

  // System wake-now paths can form feedback loops too; only manual intent is exempt.
  const floodDefer = checkFloodGuard(input);
  if (floodDefer) {
    return floodDefer;
  }
  if (input.intent === "immediate") {
    return { defer: false };
  }

  if (input.intent === "scheduled") {
    return input.now < input.nextDueMs
      ? { defer: true, reason: "not-due", retryAtMs: input.nextDueMs }
      : { defer: false };
  }

  // An idle agent can respond to its first event before the first scheduled tick.
  if (input.lastRunStartedAtMs === undefined) {
    return { defer: false };
  }

  if (input.intent !== "task" && !input.retainedWork && input.now < input.nextDueMs) {
    const spacingRetryAtMs = resolveMinSpacingRetryAtMs(input);
    return {
      defer: true,
      reason: "not-due",
      retryAtMs: Math.min(input.nextDueMs, spacingRetryAtMs ?? input.nextDueMs),
    };
  }

  const spacingRetryAtMs = resolveMinSpacingRetryAtMs(input);
  if (spacingRetryAtMs !== undefined) {
    return { defer: true, reason: "min-spacing", retryAtMs: spacingRetryAtMs };
  }

  return { defer: false };
}

function resolveMinSpacingRetryAtMs(input: ShouldDeferInput): number | undefined {
  if (input.lastRunStartedAtMs === undefined) {
    return undefined;
  }
  const retryAtMs = input.lastRunStartedAtMs + DEFAULT_MIN_WAKE_SPACING_MS;
  return input.now < retryAtMs ? retryAtMs : undefined;
}

function checkFloodGuard(input: ShouldDeferInput): DeferDecision | null {
  if (!input.recentRunStarts || input.recentRunStarts.length < DEFAULT_FLOOD_THRESHOLD) {
    return null;
  }
  const windowStart = input.now - DEFAULT_FLOOD_WINDOW_MS;
  let inWindow = 0;
  for (let i = input.recentRunStarts.length - 1; i >= 0; i--) {
    const ts = input.recentRunStarts[i];
    if (ts === undefined || ts < windowStart) {
      break;
    }
    inWindow += 1;
    if (inWindow === DEFAULT_FLOOD_THRESHOLD) {
      return { defer: true, reason: "flood", retryAtMs: ts + DEFAULT_FLOOD_WINDOW_MS + 1 };
    }
  }
  return null;
}

export function recordRunStart(buffer: number[], ts: number): void {
  buffer.push(ts);
  while (buffer.length > DEFAULT_FLOOD_THRESHOLD + 1) {
    buffer.shift();
  }
}
