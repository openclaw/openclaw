import { scheduleAbsoluteDeadline } from "../utils/absolute-deadline.js";

type PermitRelease = () => void;
type PermitWaiter = {
  expired: () => boolean;
  settle: (release: PermitRelease | null) => void;
};

/**
 * FIFO admission with caller-owned lifetime. Cancellation/deadlines only stop
 * waiting: an acquired permit stays held until its idempotent release is called.
 * acquire returns null on cancellation/expiry; tryAcquire returns null when busy.
 *
 * Prefer the relative timeoutMs budget: a positive value bounds a queued wait by
 * elapsed time on the monotonic clock, so an NTP step back cannot widen the wait
 * and a forward step cannot expire a healthy waiter (for this budget). A
 * non-positive timeoutMs means no deadline (immediate admission), matching how
 * callers treat explicit timeouts. When both are supplied, timeoutMs wins and
 * deadlineAtMs is ignored.
 *
 * deadlineAtMs is the absolute wall-clock deadline retained for callers (e.g. the
 * codex inference relay) that share one deadline across a request. Unlike
 * timeoutMs, it is re-seeded/consumed on Date.now(), so a wall-clock step shifts
 * the effective wait (back step widens, forward step shortens it). That residual
 * behavior is an accepted part of the absolute-deadline contract; callers that
 * need a wall-clock-step-invariant bound must use timeoutMs instead.
 */
export function createPermitPool(limit: number) {
  let active = 0;
  const waiters: PermitWaiter[] = [];
  let waiterHead = 0;

  const compactWaiters = () => {
    if (waiterHead >= waiters.length) {
      waiters.length = 0;
      waiterHead = 0;
    } else if (waiterHead > 256 && waiterHead * 2 > waiters.length) {
      waiters.splice(0, waiterHead);
      waiterHead = 0;
    }
  };

  const createRelease = (): PermitRelease => {
    active += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      active -= 1;
      for (let waiter = waiters[waiterHead]; waiter; waiter = waiters[waiterHead]) {
        waiterHead += 1;
        const expired = waiter.expired();
        waiter.settle(expired ? null : createRelease());
        if (!expired) {
          break;
        }
      }
      compactWaiters();
    };
  };

  const tryAcquire = (): PermitRelease | null => (active < limit ? createRelease() : null);

  return {
    get pendingCount(): number {
      return waiters.length - waiterHead;
    },
    tryAcquire,
    async acquire({
      signal,
      timeoutMs,
      deadlineAtMs,
    }: {
      signal?: AbortSignal;
      timeoutMs?: number;
      deadlineAtMs?: number;
    } = {}): Promise<PermitRelease | null> {
      const monotonicDeadlineAtMs =
        timeoutMs !== undefined && timeoutMs > 0 ? performance.now() + timeoutMs : undefined;
      const effectiveDeadlineAtMs = monotonicDeadlineAtMs ?? deadlineAtMs;
      const now = () => (monotonicDeadlineAtMs !== undefined ? performance.now() : Date.now());
      const expired = () =>
        signal?.aborted === true ||
        (effectiveDeadlineAtMs !== undefined && now() >= effectiveDeadlineAtMs);
      if (expired()) {
        return null;
      }
      const releasePermit = tryAcquire();
      if (releasePermit) {
        return releasePermit;
      }
      return await new Promise<PermitRelease | null>((resolve) => {
        let cancelDeadline: (() => void) | undefined;
        const cancel = () => {
          const index = waiters.indexOf(waiter, waiterHead);
          if (index >= waiterHead) {
            waiters.splice(index, 1);
            compactWaiters();
          }
          waiter.settle(null);
        };
        const waiter: PermitWaiter = {
          expired,
          settle: (release) => {
            cancelDeadline?.();
            signal?.removeEventListener("abort", cancel);
            resolve(release);
          },
        };
        signal?.addEventListener("abort", cancel, { once: true });
        waiters.push(waiter);
        if (effectiveDeadlineAtMs !== undefined) {
          cancelDeadline = scheduleAbsoluteDeadline(effectiveDeadlineAtMs, cancel, now, {
            unref: true,
          });
        }
      });
    },
  };
}
