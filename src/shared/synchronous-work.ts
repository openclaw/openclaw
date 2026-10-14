export type SynchronousWork<T> = Generator<void, T, void>;

/** Consume the same incremental operation when the caller cannot yield. */
export function runSynchronousWork<T>(work: SynchronousWork<T>): T {
  let step = work.next();
  while (!step.done) {
    step = work.next();
  }
  return step.value;
}
