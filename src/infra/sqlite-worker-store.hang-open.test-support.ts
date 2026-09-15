/**
 * Existing-only backend that never returns from open — models a wedged native
 * chat.db open inside a worker thread (see #148750 / PER-1695).
 */
export function openExistingSqliteWorkerBackend(
  _input: undefined,
  _context: { databasePath: string },
): never {
  // Park the worker thread forever without burning CPU. The host open promise
  // stays pending, which is what pins shared broker admission on tip.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("unreachable: hang-open fixture resumed");
}
