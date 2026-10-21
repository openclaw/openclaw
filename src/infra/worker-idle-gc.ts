import { Session } from "node:inspector/promises";
import { isMainThread } from "node:worker_threads";

const IDLE_GC_DELAY_MS = 1_000;
const IDLE_GC_GROWTH_BYTES = 32 * 1024 * 1024;
let collectedMemory = { heapUsed: 0, external: 0 };
let session: Session | null | undefined;
let pending: NodeJS.Timeout | undefined;
let collecting = false;

function hasIdleGarbageGrowth(): boolean {
  // These isolate-local counters avoid heap walks; external already includes ArrayBuffers.
  const memory = process.memoryUsage();
  return (
    memory.heapUsed > collectedMemory.heapUsed + IDLE_GC_GROWTH_BYTES ||
    memory.external > collectedMemory.external + IDLE_GC_GROWTH_BYTES
  );
}

async function collectWorkerIdleGarbage(): Promise<void> {
  pending = undefined;
  if (!hasIdleGarbageGrowth()) {
    return;
  }
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
    // A task overlapping collection can leave garbage until the next idle growth sample.
    collectedMemory = process.memoryUsage();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Inspector error -32601:")) {
      session = null;
    } else {
      process.emitWarning(error instanceof Error ? error : String(error));
    }
  } finally {
    collecting = false;
  }
}

/** Only native worker owners call this after releasing their operation's payloads. */
export function scheduleWorkerIdleGc(): void {
  if (isMainThread || session === null) {
    return;
  }
  if (pending || collecting) {
    return;
  }
  if (!hasIdleGarbageGrowth()) {
    return;
  }
  // A reply can immediately trigger another task; allow that burst to finish first.
  pending = setTimeout(() => {
    void collectWorkerIdleGarbage();
  }, IDLE_GC_DELAY_MS).unref();
}

/** A new operation takes precedence over collection of the preceding idle heap. */
export function cancelWorkerIdleGc(): void {
  clearTimeout(pending);
  pending = undefined;
}
