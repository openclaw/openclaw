import { Session } from "node:inspector/promises";
import { getHeapStatistics } from "node:v8";
import { isMainThread } from "node:worker_threads";

const IDLE_GC_GROWTH_BYTES = 32 * 1024 * 1024;
let collectedHeap = 0;
let session: Session | null | undefined;
let pending: NodeJS.Immediate | undefined;
let collecting = false;
let idle = false;
let generation = 0;

/** Only native worker owners call this after releasing their operation's payloads. */
export function scheduleWorkerIdleGc(): void {
  if (isMainThread || session === null) {
    return;
  }
  idle = true;
  if (pending || collecting) {
    return;
  }
  pending = setImmediate(async () => {
    pending = undefined;
    if (getHeapStatistics().used_heap_size <= collectedHeap + IDLE_GC_GROWTH_BYTES) {
      return;
    }
    const collectingGeneration = generation;
    collecting = true;
    try {
      if (!session) {
        const connection = new Session();
        connection.connect();
        // Keep the local session until worker teardown. Disconnecting during GC
        // completion deadlocks V8 and tears down other profiler state.
        session = connection;
      }
      await session.post("HeapProfiler.collectGarbage");
      collecting = false;
      if (collectingGeneration === generation) {
        collectedHeap = getHeapStatistics().used_heap_size;
      } else if (idle) {
        // A successor finished while GC was pending; its released heap needs a new sample.
        scheduleWorkerIdleGc();
      }
    } catch (error) {
      collecting = false;
      if (error instanceof Error && error.message.startsWith("Inspector error -32601:")) {
        session = null;
      } else {
        process.emitWarning(error instanceof Error ? error : String(error));
      }
    }
  }).unref();
}

/** A new operation takes precedence over collection of the preceding idle heap. */
export function cancelWorkerIdleGc(): void {
  generation++;
  idle = false;
  clearImmediate(pending);
  pending = undefined;
}
