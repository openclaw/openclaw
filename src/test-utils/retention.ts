import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { writeHeapSnapshot } from "node:v8";

/** Assert the retained population after giving unowned objects a collection turn. */
export async function expectLiveObjects(
  references: readonly WeakRef<object>[],
  expected: number,
): Promise<void> {
  await collectForRetentionCheck("live-objects");
  assert.equal(references.filter((reference) => reference.deref() !== undefined).length, expected);
}

/** Collects between jobs while the fixture keeps its real resource alive. */
export async function collectForRetentionCheck(label: string): Promise<void> {
  const gc = globalThis.gc;
  assert.ok(gc, "The retention fixture requires --expose-gc");
  const control = new WeakRef({ unowned: true });
  const directory = process.env.OPENCLAW_RETENTION_SNAPSHOT_DIR;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    writeHeapSnapshot(path.join(directory, `${label}-before.heapsnapshot`));
  }
  for (let pass = 0; pass < 8; pass += 1) {
    await setImmediate();
    gc();
  }
  assert.equal(control.deref(), undefined, "Unowned control must collect");
  if (directory) {
    writeHeapSnapshot(path.join(directory, `${label}-after.heapsnapshot`));
  }
}
