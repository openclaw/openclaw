import { writeFileSync } from "node:fs";

/**
 * Existing-only backend that never returns from open — models a wedged native
 * chat.db open inside a worker thread (see #148750 / PER-1695).
 *
 * Writes `${databasePath}.factory-entered` before parking so tests can wait for
 * an explicit factory-entry signal before starting a healthy shared open.
 */
export function openExistingSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): never {
  writeFileSync(`${context.databasePath}.factory-entered`, "factory-entered\n");
  // Park the worker thread forever without burning CPU. The host open promise
  // stays pending, which is what would pin a shared admissionTail on tip.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("unreachable: hang-open fixture resumed");
}
