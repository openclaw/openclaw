import { threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type PostgresBridgeCounter = {
  threadId: number;
  count: Int32Array<SharedArrayBuffer>;
  selfRootCount?: Int32Array<SharedArrayBuffer>;
};

export function readPostgresBridgeCounters(value: unknown): PostgresBridgeCounter[] {
  if (!Array.isArray(value)) {
    return [];
  }
  // A child can never own its parent's direct counter, even through a loopback transport.
  return value.filter(
    (entry): entry is PostgresBridgeCounter =>
      isRecord(entry) &&
      typeof entry.threadId === "number" &&
      Number.isSafeInteger(entry.threadId) &&
      entry.threadId !== threadId &&
      entry.count instanceof Int32Array &&
      entry.count.length === 1 &&
      entry.count.buffer instanceof SharedArrayBuffer &&
      (entry.selfRootCount === undefined ||
        (entry.selfRootCount instanceof Int32Array &&
          entry.selfRootCount.length === 1 &&
          entry.selfRootCount.buffer instanceof SharedArrayBuffer)),
  );
}

/** Physical identity survives shared-buffer cloning and retained-handle forwarding. */
export function collectPostgresBridgeCounters(
  count: Int32Array<SharedArrayBuffer>,
  sources: Iterable<{ postgresBridgeCounters?: readonly PostgresBridgeCounter[] }>,
  selfRootCount?: Int32Array<SharedArrayBuffer>,
): PostgresBridgeCounter[] {
  const counters = new Map<number, PostgresBridgeCounter>([
    [threadId, { threadId, count, selfRootCount }],
  ]);
  for (const source of sources) {
    for (const counter of source.postgresBridgeCounters ?? []) {
      counters.set(counter.threadId, counter);
    }
  }
  return [...counters.values()];
}

export function countPostgresBridges(counters: readonly PostgresBridgeCounter[]): number {
  return counters.reduce((total, counter) => total + Atomics.load(counter.count, 0), 0);
}

export function countPostgresPoolSelfRoots(counters: readonly PostgresBridgeCounter[]): number {
  return counters.reduce(
    (total, counter) =>
      total + (counter.selfRootCount ? Atomics.load(counter.selfRootCount, 0) : 0),
    0,
  );
}
