import { Session } from "node:inspector";
import { getHeapStatistics } from "node:v8";
import { isMainThread } from "node:worker_threads";

const IDLE_GC_GROWTH_BYTES = 32 * 1024 * 1024;
let collectedHeap = 0;
let session: Session | undefined;
let pending: NodeJS.Immediate | undefined;
let collecting = false;
let idle = false;
let generation = 0;

/** Only native worker owners call this after releasing their operation's payloads. */
export function scheduleWorkerIdleGc(): void {
  if (isMainThread || process.versions.bun) {
    return;
  }
  idle = true;
  if (pending || collecting) {
    return;
  }
  pending = setImmediate(() => {
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
        // Keep this non-blocking local session until worker teardown. Disconnecting
        // inside the GC callback deadlocks V8 and tears down other profiler state.
        session = connection;
      }
      session.post("HeapProfiler.collectGarbage", (error) => {
        collecting = false;
        if (error) {
          process.emitWarning(error);
        } else if (collectingGeneration === generation) {
          collectedHeap = getHeapStatistics().used_heap_size;
        } else if (idle) {
          // A successor finished while GC was pending; its released heap needs a new sample.
          scheduleWorkerIdleGc();
        }
      });
    } catch (error) {
      collecting = false;
      process.emitWarning(error instanceof Error ? error : String(error));
    }
  });
  pending.unref();
}

/** A new operation takes precedence over collection of the preceding idle heap. */
export function cancelWorkerIdleGc(): void {
  generation++;
  idle = false;
  clearImmediate(pending);
  pending = undefined;
}
