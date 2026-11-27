import {
  monotonicDeadlineAfter,
  monotonicNow,
  remainingMonotonicMs,
} from "../../../../src/shared/monotonic-time.ts";
import { scheduleAbsoluteDeadline } from "../../../../src/utils/absolute-deadline.ts";
import { resolveGatewayReadRetryDelayMs } from "../gateway-availability.ts";
import { isRetryableGatewayReadError } from "../gateway-errors.ts";
import type { SessionWindowExpiry } from "./session-requests.ts";

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
  let windowWake: { queued: boolean; retryAt: number | null; dueAt: number } | undefined;
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
  const acceptWindowExpiry = (receipt: SessionWindowExpiry | null | undefined, append = false) => {
    const next = receipt?.at;
    // A later page may already have crossed an earlier page's real Gateway cutoff.
    const crossed = receipt && receipt.sampledAt > receipt.at;
    const deadline = receipt
      ? monotonicDeadlineAfter(Math.max(0, receipt.at - receipt.sampledAt + 1))
      : Infinity;
    // Only a replacement covers the prefix. A tail can bring its wake forward,
    // but cannot cancel or delay it, even if the two receipts took different times to arrive.
    if (
      (next === windowExpiry &&
        (!crossed || armedWindowDeadline === Infinity || deadline >= armedWindowDeadline)) ||
      (append && (windowWake || deadline >= armedWindowDeadline))
    ) {
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
          windowWake = { queued: true, retryAt: null, dueAt: deadline };
          arm(false);
        },
        monotonicNow,
      );
    }
  };
  const reset = () => {
    absorb();
    acceptWindowExpiry(null);
    // A consumer wake can exist without a receipt for acceptance to retire.
    windowWake = undefined;
    windowRead = undefined;
    pending = null;
    nextAllowed = 0;
  };

  return {
    acceptWindowExpiry,
    beginWindowRead(issuedAt: number, isCurrent: () => boolean, append: boolean) {
      const request = {};
      windowRead = request;
      // An append cannot replace the expired prefix. A read issued before expiry
      // may likewise return its old cutoff; leave its trailing wake to acceptance.
      const wake = !append && windowWake && issuedAt >= windowWake.dueAt ? windowWake : undefined;
      const cutoff = windowExpiry;
      if (wake) {
        windowWake = undefined;
      } else if (windowWake) {
        // This owner joined an older transport, or only read the tail. A due
        // prefix wake stays owed unless acceptance supersedes its receipt.
        windowWake.queued = true;
      }
      return (error?: unknown) => {
        if (windowRead !== request) {
          return;
        }
        windowRead = undefined;
        if (
          wake?.retryAt === null &&
          cutoff === windowExpiry &&
          isCurrent() &&
          isRetryableGatewayReadError(error, "sessions.list")
        ) {
          windowWake = {
            ...wake,
            queued: true,
            retryAt: monotonicDeadlineAfter(resolveGatewayReadRetryDelayMs(error)),
          };
        }
        if (windowWake?.queued) {
          arm(false);
        }
      };
    },
    /** A consumer's Gateway deadline outside this window's receipt; shares the cutoff's read and retry. */
    wake() {
      windowWake ??= { queued: true, retryAt: null, dueAt: monotonicNow() };
      windowWake.queued = true;
      arm(false);
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
