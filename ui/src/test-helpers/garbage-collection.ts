import { setImmediate as scheduleImmediate } from "node:timers";
import { setImmediate } from "node:timers/promises";

declare const Bun: { gc(force: boolean): void };

export async function collectGarbageForTest(collectInNode?: () => void): Promise<void> {
  // WeakRef targets stay alive for the current job, even without a strong owner.
  if (process.versions.bun) {
    // A resumed promise can retain its value during the continuation's microtask.
    // Collect inside the native callback, before resolving the next continuation.
    return new Promise<void>((resolve, reject) => {
      scheduleImmediate(() => {
        try {
          Bun.gc(true);
          resolve();
        } catch (error) {
          reject(new Error("Bun garbage collection failed", { cause: error }));
        }
      });
    });
  }
  await setImmediate();
  if (collectInNode) {
    collectInNode();
  } else {
    const { Session } = await import("node:inspector");
    const session = new Session();
    session.connect();
    try {
      await new Promise<void>((resolve, reject) => {
        session.post("HeapProfiler.collectGarbage", (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    } finally {
      // Disconnect after the GC callback releases V8's internal callback lock.
      await setImmediate();
      session.disconnect();
    }
  }
}
