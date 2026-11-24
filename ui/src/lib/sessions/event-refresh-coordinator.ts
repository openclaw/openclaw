import {
  monotonicDeadlineAfter,
  monotonicNow,
  remainingMonotonicMs,
} from "../../../../src/shared/monotonic-time.ts";
import { scheduleAbsoluteDeadline } from "../../../../src/utils/absolute-deadline.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { resolveGatewayReadRetryDelayMs } from "../gateway-availability.ts";
import { isRetryableGatewayReadError } from "../gateway-errors.ts";

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
  let armedWindowDeadline = Infinity;
  // Keep the cutoff's work distinct from events: a newer receipt can retire
  // just this wake, including one waiting for background admission.
  let windowWake: { queued: boolean; retryAt: number | null } | undefined;
  let windowRead: object | undefined;
  let cancelWindowExpiry: (() => void) | undefined;
  const needsRefresh = () => queued || (!windowRead && windowWake?.queued);

  const clearTimer = () => {
    clearTimeout(timer);
    timer = 0;
  };

  const arm = (debounce = true) => {
    if (!active || pending || !needsRefresh() || timer) {
      return;
    }
    const delay = debounce ? SESSION_EVENT_REFRESH_DEBOUNCE_MS * (1 - 0.2 * Math.random()) : 0;
    timer = setTimeout(
      start,
      retryAt !== null
        ? Math.max(0, remainingMonotonicMs(retryAt))
        : Math.max(delay, remainingMonotonicMs(Math.max(nextAllowed, windowWake?.retryAt ?? 0))),
    );
  };

  const start = () => {
    clearTimer();
    if (!active || pending || !needsRefresh()) {
      return;
    }
    const event = queued;
    const wake = windowWake;
    if (wake) {
      wake.queued = false;
    }
    queued = false;
    retryAt = null;
    const request = {};
    pending = request;
    const started = monotonicNow();
    const requestRevision = revision;
    void refresh(
      () => pending === request && requestRevision === revision && (event || wake === windowWake),
    )
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
    append = false,
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
    const deadline =
      next !== undefined && result ? monotonicDeadlineAfter(next - result.ts + 1) : Infinity;
    // Only a replacement covers the prefix. A tail can bring its wake forward,
    // but cannot cancel or delay it, even if the two receipts took different times to arrive.
    if (next === windowExpiry || (append && (windowWake || deadline >= armedWindowDeadline))) {
      return;
    }
    if (windowWake && !queued) {
      clearTimer();
    }
    windowWake = undefined;
    cancelWindowExpiry?.();
    cancelWindowExpiry = undefined;
    windowExpiry = next;
    armedWindowDeadline = deadline;
    if (next !== undefined) {
      cancelWindowExpiry = scheduleAbsoluteDeadline(
        deadline,
        () => {
          armedWindowDeadline = Infinity;
          windowWake = { queued: true, retryAt: null };
          arm(false);
        },
        monotonicNow,
      );
    }
  };
  const reset = () => {
    absorb();
    acceptWindowExpiry(null);
    windowRead = undefined;
    pending = null;
    nextAllowed = 0;
  };

  return {
    acceptWindowExpiry,
    async readWindow<T>(read: () => Promise<T>, isCurrent: () => boolean, append: boolean) {
      const request = {};
      windowRead = request;
      // An append cannot replace the expired prefix. A read issued before expiry
      // may likewise return its old cutoff; leave its trailing wake to acceptance.
      const wake = append ? undefined : windowWake;
      const cutoff = windowExpiry;
      if (wake) {
        windowWake = undefined;
      }
      try {
        return await read();
      } catch (error) {
        if (
          wake?.retryAt === null &&
          windowRead === request &&
          cutoff === windowExpiry &&
          isCurrent() &&
          isRetryableGatewayReadError(error, "sessions.list")
        ) {
          windowWake = {
            queued: true,
            retryAt: monotonicDeadlineAfter(resolveGatewayReadRetryDelayMs(error)),
          };
        }
        throw error;
      } finally {
        if (windowRead === request) {
          windowRead = undefined;
          if (windowWake?.queued) {
            arm(false);
          }
        }
      }
    },
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
      queued ||= markDirty;
      clearTimer();
    },
    absorb,
    reset,
    dispose: reset,
  };
}
