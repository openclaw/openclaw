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

  const createRelease = (): PermitRelease => {
    active += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      active -= 1;
      for (let waiter = waiters.shift(); waiter; waiter = waiters.shift()) {
        const expired = waiter.expired();
        waiter.settle(expired ? null : createRelease());
        if (!expired) {
          break;
        }
      }
    };
  };

  const tryAcquire = (): PermitRelease | null => (active < limit ? createRelease() : null);

  return {
    get pendingCount(): number {
      return waiters.length;
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
        const cancel = () => waiter.settle(null);
        const waiter: PermitWaiter = {
          expired,
          settle: (release) => {
            cancelDeadline?.();
            signal?.removeEventListener("abort", cancel);
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
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
