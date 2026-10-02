import { setImmediate as scheduleImmediate } from "node:timers";
import { setImmediate } from "node:timers/promises";

declare const Bun: { gc(force: boolean): void };

export async function collectGarbageForTest(): Promise<void> {
  // WeakRef targets stay alive for the current job, even without a strong owner.
  if (process.versions.bun) {
    // Collect outside JavaScriptCore's promise-microtask drain, whose stack
    // can otherwise keep settled async values alive.
    await new Promise<void>((resolve) => {
      scheduleImmediate(() => {
        Bun.gc(true);
        resolve();
      });
    });
    return;
  }
  await setImmediate();
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
