import type { ReplyPayload } from "../reply-payload.js";
import type { ReplyOperationPhase } from "./reply-run-registry.js";

export const DEFAULT_REPLY_RUN_PROGRESS_FIRST_NOTICE_MS = 5 * 60 * 1000;
export const DEFAULT_REPLY_RUN_PROGRESS_REPEAT_MS = 5 * 60 * 1000;

export type ReplyRunProgressWatchdogPhase = Exclude<
  ReplyOperationPhase,
  "completed" | "failed" | "aborted"
>;

export type ReplyRunProgressNotice = {
  phase: ReplyRunProgressWatchdogPhase;
  elapsedMs: number;
};

export type ReplyRunProgressWatchdog = {
  markVisibleActivity(): void;
  stop(): void;
};

type TimerHandle = NodeJS.Timeout;

type ReplyRunProgressWatchdogParams = {
  enabled: boolean;
  firstNoticeMs?: number;
  repeatNoticeMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  getPhase: () => ReplyOperationPhase;
  sendNotice: (notice: ReplyRunProgressNotice) => Promise<void> | void;
  onError?: (error: unknown) => void;
};

function normalizeDelayMs(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1_000, Math.floor(value));
}

function isTerminalPhase(phase: ReplyOperationPhase): phase is "completed" | "failed" | "aborted" {
  return phase === "completed" || phase === "failed" || phase === "aborted";
}

function formatPhaseLabel(phase: ReplyRunProgressWatchdogPhase): string {
  return phase.replaceAll("_", " ");
}

export function buildReplyRunProgressNoticeText(notice: ReplyRunProgressNotice): string {
  const elapsedMinutes = Math.max(1, Math.round(notice.elapsedMs / 60_000));
  return `Still working — current phase: ${formatPhaseLabel(notice.phase)} (${elapsedMinutes}m elapsed). I’ll send the final reply when it’s ready.`;
}

export function buildReplyRunProgressPayload(notice: ReplyRunProgressNotice): ReplyPayload {
  return { text: buildReplyRunProgressNoticeText(notice) };
}

export function createReplyRunProgressWatchdog(
  params: ReplyRunProgressWatchdogParams,
): ReplyRunProgressWatchdog {
  const now = params.now ?? Date.now;
  const setTimer = params.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = params.clearTimer ?? ((timer) => clearTimeout(timer));
  const firstNoticeMs = normalizeDelayMs(
    params.firstNoticeMs,
    DEFAULT_REPLY_RUN_PROGRESS_FIRST_NOTICE_MS,
  );
  const repeatNoticeMs = normalizeDelayMs(
    params.repeatNoticeMs,
    DEFAULT_REPLY_RUN_PROGRESS_REPEAT_MS,
  );
  const startedAt = now();
  let lastVisibleActivityAt = startedAt;
  let noticeCount = 0;
  let active = params.enabled;
  let timer: TimerHandle | undefined;
  let sending = false;

  const clearCurrentTimer = () => {
    if (timer) {
      clearTimer(timer);
      timer = undefined;
    }
  };

  const schedule = () => {
    clearCurrentTimer();
    if (!active) {
      return;
    }
    const delayMs = noticeCount === 0 ? firstNoticeMs : repeatNoticeMs;
    const dueAt = lastVisibleActivityAt + delayMs;
    timer = setTimer(
      () => {
        void tick();
      },
      Math.max(1_000, dueAt - now()),
    );
  };

  const tick = async () => {
    if (!active || sending) {
      return;
    }
    const phase = params.getPhase();
    if (isTerminalPhase(phase)) {
      active = false;
      clearCurrentTimer();
      return;
    }
    const currentTime = now();
    const delayMs = noticeCount === 0 ? firstNoticeMs : repeatNoticeMs;
    if (currentTime - lastVisibleActivityAt < delayMs) {
      schedule();
      return;
    }
    sending = true;
    try {
      await params.sendNotice({ phase, elapsedMs: currentTime - startedAt });
      lastVisibleActivityAt = now();
      noticeCount += 1;
    } catch (error) {
      params.onError?.(error);
      // Do not spin on failing transports; retry on the normal repeat cadence.
      lastVisibleActivityAt = now();
      noticeCount += 1;
    } finally {
      sending = false;
      schedule();
    }
  };

  if (active) {
    schedule();
  }

  return {
    markVisibleActivity() {
      if (!active) {
        return;
      }
      lastVisibleActivityAt = now();
      schedule();
    },
    stop() {
      active = false;
      clearCurrentTimer();
    },
  };
}
