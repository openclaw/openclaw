import { setImmediate as scheduleImmediate } from "node:timers";
import { setImmediate } from "node:timers/promises";

export async function collectGarbageForTest(): Promise<void> {
  // WeakRef targets stay alive for the current job, even without a strong owner.
  await setImmediate();
  const { Session } = await import("node:inspector/promises");
  const session = new Session();
  session.connect();
  try {
    await session.post("HeapProfiler.collectGarbage");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ERR_INSPECTOR_COMMAND" ||
      error.message !== "Inspector error -32601: 'HeapProfiler.collectGarbage' wasn't found"
    ) {
      throw error;
    }
    const bun = (globalThis as typeof globalThis & { Bun?: { gc(force: boolean): void } }).Bun;
    if (typeof bun?.gc !== "function") {
      throw error;
    }
    await new Promise<void>((resolve, reject) => {
      scheduleImmediate(() => {
        try {
          // A promise continuation can leave stale JavaScriptCore stack roots.
          bun.gc(true);
          resolve();
        } catch (gcError) {
          reject(gcError instanceof Error ? gcError : new Error(String(gcError)));
        }
      });
    });
  } finally {
    // Disconnect after the GC callback releases V8's internal callback lock.
    await setImmediate();
    session.disconnect();
  }
}
