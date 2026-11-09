import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers";
import { writeHeapSnapshot } from "node:v8";

/** Force a full collection without depending on heap-inspection APIs. */
function forceFullGc(): void {
  const bun = (globalThis as typeof globalThis & { Bun?: { gc(full: boolean): unknown } }).Bun;
  if (typeof bun?.gc === "function") {
    bun.gc(true);
    return;
  }
  assert.ok(globalThis.gc, "The retention fixture requires --expose-gc");
  globalThis.gc();
}

/** Collects between jobs while the fixture keeps its real resource alive. */
export async function collectForRetentionCheck(label: string, passes = 8): Promise<void> {
  const control = new WeakRef({ unowned: true });
  const directory = process.env.OPENCLAW_RETENTION_SNAPSHOT_DIR;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    writeHeapSnapshot(path.join(directory, `${label}-before.heapsnapshot`));
  }
  // JSC promise frames can retain completed callers; collect from a native callback.
  for (let pass = 0; pass < passes; pass += 1) {
    await new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        try {
          forceFullGc();
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }
  assert.equal(control.deref(), undefined, "Unowned control must collect");
  if (directory) {
    writeHeapSnapshot(path.join(directory, `${label}-after.heapsnapshot`));
  }
}
