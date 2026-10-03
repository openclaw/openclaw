import { setImmediate } from "node:timers/promises";

export async function collectGarbageForTest(): Promise<void> {
  if (process.versions.bun) {
    throw new Error(
      "collectGarbageForTest needs V8's precise collection: JavaScriptCore scans stacks " +
        "conservatively, so a forced Bun GC cannot prove a WeakRef target is unreachable. " +
        "Add this file to the ui/vitest.config.ts nodeRequired set in scripts/lib/ci-test-runtime.mts.",
    );
  }
  // WeakRef targets stay alive for the current job, even without a strong owner.
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
