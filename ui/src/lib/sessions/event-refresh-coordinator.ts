import {
  monotonicDeadlineAfter,
  monotonicNow,
  remainingMonotonicMs,
} from "../../../../src/shared/monotonic-time.ts";
import { scheduleAbsoluteDeadline } from "../../../../src/utils/absolute-deadline.ts";
import type { SessionsListResult } from "../../api/types.ts";

const SESSION_EVENT_REFRESH_DEBOUNCE_MS = 5_000;

type SessionEventRefreshCoordinatorOptions = {
  active: boolean;
  refresh: (isCurrent: () => boolean) => Promise<void>;
};

/** Canonical bounded event refresh policy shared by session-list owners. */
export function createSessionEventRefreshCoordinator({
  active: initialActive,
  refresh,
}: SessionEventRefreshCoordinatorOptions) {
  let active = initialActive;
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  let nextAllowed = 0;
  let pending: object | null = null;
  let revision = 0;
  // Hidden pages and in-flight requests retain one trailing invalidation.
  let queued = false;
  let retryAt: number | null = null;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  let windowExpiry: number | undefined;
  let cancelWindowExpiry: (() => void) | undefined;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = 0;
  };

  const arm = (debounce = true) => {
    if (!active || pending || !queued || timer) {
      return;
    }
    const delay = debounce ? SESSION_EVENT_REFRESH_DEBOUNCE_MS * (1 - 0.2 * Math.random()) : 0;
    timer = setTimeout(
      start,
      retryAt !== null
        ? Math.max(0, remainingMonotonicMs(retryAt))
        : Math.max(delay, remainingMonotonicMs(nextAllowed)),
    );
  };

  const start = () => {
    clearTimer();
    if (!active || pending || !queued) {
      return;
    }
    queued = false;
    retryAt = null;
    const request = {};
    pending = request;
    const started = monotonicNow();
    const requestRevision = revision;
    void refresh(() => pending === request && requestRevision === revision)
      .catch(() => {})
      .finally(() => {
        if (pending !== request) {
          return;
        }
        pending = null;
        const elapsed = monotonicNow() - started;
        nextAllowed = monotonicDeadlineAfter(Math.min(15_000, Math.max(5_000, 3 * elapsed)));
        arm();
      });
  };

  const absorb = () => {
    clearTimeout(fallback);
    fallback = undefined;
    revision += 1;
    clearTimer();
    queued = false;
    retryAt = null;
  };
  const acceptWindowExpiry = (
    result: Pick<SessionsListResult, "ts" | "activityExpiresAt"> | null,
  ) => {
    const at = result?.activityExpiresAt;
    // The Gateway's last valid millisecond covers even candidates outside this page.
    const next =
      result &&
      at !== undefined &&
      Number.isSafeInteger(at) &&
      Number.isSafeInteger(result.ts) &&
      at >= result.ts
        ? at
        : undefined;
    if (next === windowExpiry) {
      return; // A repeated receipt cannot postpone or replay the same wake.
    }
    cancelWindowExpiry?.();
    cancelWindowExpiry = undefined;
    windowExpiry = next;
    if (next !== undefined && result) {
      cancelWindowExpiry = scheduleAbsoluteDeadline(
        monotonicDeadlineAfter(next - result.ts + 1),
        () => {
          queued = true;
          arm(false);
        },
        monotonicNow,
      );
    }
  };
  const reset = () => {
    absorb();
    acceptWindowExpiry(null);
    pending = null;
    nextAllowed = 0;
  };

  return {
    acceptWindowExpiry,
    scheduleFallback() {
      fallback ??= setTimeout(() => {
        fallback = undefined;
        queued = true;
        arm();
      }, 60_000);
    },
    scheduleRetry(delayMs: number) {
      retryAt = monotonicDeadlineAfter(delayMs);
      queued = true;
      clearTimer();
      arm(false);
    },
    schedule() {
      queued = true;
      arm();
    },
    setActive(next: boolean, markDirty = false) {
      active = next;
      if (next) {
        arm(false);
        return;
      }
      queued ||= markDirty || timer !== 0;
      clearTimer();
    },
    absorb,
    reset,
    dispose: reset,
  };
}
