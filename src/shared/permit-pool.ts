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
      deadlineAtMs,
    }: { signal?: AbortSignal; deadlineAtMs?: number } = {}): Promise<PermitRelease | null> {
      const expired = () =>
        signal?.aborted === true || (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs);
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
        if (deadlineAtMs !== undefined) {
          cancelDeadline = scheduleAbsoluteDeadline(deadlineAtMs, cancel, undefined, {
            unref: true,
          });
        }
      });
    },
  };
}
