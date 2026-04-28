import { defaultRuntime } from "../../../runtime.js";
import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import { getExistingFollowupQueue } from "./state.js";
import type { FollowupRun } from "./types.js";

const DISCORD_STUCK_SESSION_BREAKER_TIMERS_KEY = Symbol.for(
  "openclaw.discordStuckSessionCircuitBreakerTimers",
);

const DISCORD_STUCK_SESSION_BREAKER_TIMERS = resolveGlobalMap<
  string,
  ReturnType<typeof setTimeout>
>(DISCORD_STUCK_SESSION_BREAKER_TIMERS_KEY);

export const DISCORD_STUCK_SESSION_BREAKER_THRESHOLD_MS = 5 * 60 * 1000;

const RECOVERY_NOTICE_PROMPT = [
  "The previous Discord turn appears stuck and queued messages are waiting.",
  "First, briefly acknowledge that recovery kicked in, then handle the queued user message normally.",
].join("\n");

function isDiscordOrigin(run: FollowupRun): boolean {
  return run.originatingChannel === "discord" || run.run.messageProvider === "discord";
}

function clearDiscordStuckSessionCircuitBreaker(queueKey: string): void {
  const existing = DISCORD_STUCK_SESSION_BREAKER_TIMERS.get(queueKey);
  if (!existing) {
    return;
  }
  clearTimeout(existing);
  DISCORD_STUCK_SESSION_BREAKER_TIMERS.delete(queueKey);
}

function buildRecoveryNoticeRun(item: FollowupRun): FollowupRun {
  return {
    ...item,
    prompt: RECOVERY_NOTICE_PROMPT,
    transcriptPrompt: RECOVERY_NOTICE_PROMPT,
    messageId: undefined,
    summaryLine: "Discord stuck-session recovery notice",
    enqueuedAt: Date.now(),
    images: undefined,
    imageOrder: undefined,
  };
}

export function scheduleDiscordStuckSessionCircuitBreaker(params: {
  queueKey: string;
  followupRun: FollowupRun;
  runFollowup: (run: FollowupRun) => Promise<void>;
  resolveActiveRunSessionId: () => string | undefined;
  isRunActive: () => boolean;
  isRunStreaming: () => boolean;
  abortActiveRun: (activeSessionId: string) => boolean;
  scheduleDrain: (key: string, runFollowup: (run: FollowupRun) => Promise<void>) => void;
  thresholdMs?: number;
}): void {
  const { queueKey, followupRun } = params;
  if (!queueKey.trim() || !isDiscordOrigin(followupRun)) {
    return;
  }

  const queue = getExistingFollowupQueue(queueKey);
  if (!queue || queue.items.length === 0) {
    clearDiscordStuckSessionCircuitBreaker(queueKey);
    return;
  }

  // One breaker timer per queue key. A fresh enqueue updates lastEnqueuedAt on
  // the queue; the existing timer will reschedule until the threshold is met.
  if (DISCORD_STUCK_SESSION_BREAKER_TIMERS.has(queueKey)) {
    return;
  }

  const thresholdMs = Math.max(1, params.thresholdMs ?? DISCORD_STUCK_SESSION_BREAKER_THRESHOLD_MS);
  const arm = (delayMs: number) => {
    const timer = setTimeout(() => {
      DISCORD_STUCK_SESSION_BREAKER_TIMERS.delete(queueKey);
      const latest = getExistingFollowupQueue(queueKey);
      if (!latest || latest.items.length === 0) {
        return;
      }

      const oldestQueuedAt = Math.min(...latest.items.map((item) => item.enqueuedAt));
      const ageMs = Date.now() - Math.min(oldestQueuedAt, latest.lastEnqueuedAt || oldestQueuedAt);
      if (ageMs < thresholdMs) {
        arm(thresholdMs - ageMs);
        return;
      }

      if (!params.isRunActive() || params.isRunStreaming()) {
        return;
      }

      const activeSessionId = params.resolveActiveRunSessionId();
      if (!activeSessionId) {
        return;
      }

      const aborted = params.abortActiveRun(activeSessionId);
      defaultRuntime.log?.(
        `discord stuck-session circuit breaker fired for ${queueKey}: queueDepth=${latest.items.length}, activeSessionId=${activeSessionId}, aborted=${aborted}`,
      );
      if (!aborted) {
        return;
      }

      latest.items.unshift(buildRecoveryNoticeRun(latest.items[0]));
      latest.lastEnqueuedAt = Date.now();
      latest.draining = false;
      params.scheduleDrain(queueKey, params.runFollowup);
    }, delayMs);
    DISCORD_STUCK_SESSION_BREAKER_TIMERS.set(queueKey, timer);
  };

  const oldestQueuedAt = Math.min(...queue.items.map((item) => item.enqueuedAt));
  const ageMs = Date.now() - Math.min(oldestQueuedAt, queue.lastEnqueuedAt || oldestQueuedAt);
  arm(Math.max(1, thresholdMs - ageMs));
}

export function resetDiscordStuckSessionCircuitBreakerForTest(): void {
  for (const timer of DISCORD_STUCK_SESSION_BREAKER_TIMERS.values()) {
    clearTimeout(timer);
  }
  DISCORD_STUCK_SESSION_BREAKER_TIMERS.clear();
}
