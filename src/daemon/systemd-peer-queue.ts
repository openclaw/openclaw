/** One sd-bus connection; callers may expire while waiting, disposal still joins native work. */
import { scheduleAbsoluteDeadline } from "../utils/absolute-deadline.js";
import { getServiceInspectionClock } from "./service-inspection-budget.js";
import { ServiceInspectionError } from "./service-inspection-error.js";

export function createSystemdPeerQueue() {
  let tail: Promise<void> = Promise.resolve();
  return {
    drain: () => tail,
    run<T>(
      deadline: number,
      execute: () => Promise<T>,
      now = getServiceInspectionClock(),
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        let expired = false;
        const expire = () => {
          expired = true;
          reject(new ServiceInspectionError("systemd-inspection-deadline-exceeded"));
        };
        const remaining = deadline - now();
        if (remaining <= 0) {
          expire();
          return;
        }
        const cancelDeadline = scheduleAbsoluteDeadline(deadline, expire, now);
        const work = tail.then(async () => {
          cancelDeadline();
          if (expired || now() >= deadline) {
            expire();
            return;
          }
          // Once started, the native call owns its remaining I/O budget. We must
          // join its actual completion, even when another queued caller expires.
          try {
            resolve(await execute());
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new Error("Original systemd manager peer query failed.", { cause: error }),
            );
          }
        });
        // An ordinary property error is not an identity change. The next query
        // revalidates the same connection instead of inheriting that rejection.
        tail = work.then(() => {}, reject);
      });
    },
  };
}
