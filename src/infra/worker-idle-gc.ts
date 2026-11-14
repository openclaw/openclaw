import { Session } from "node:inspector/promises";
import { isMainThread, threadId } from "node:worker_threads";

declare const Bun: { gc(full: boolean): number };

const IDLE_GC_DELAY_MS = 1_000;
const IDLE_GC_GROWTH_BYTES = 32 * 1024 * 1024;
const SLOW_IDLE_GC_MS = 1_000;
const bun = typeof Bun === "object" ? Bun : undefined;
let collectedMemory = { heapUsed: 0, external: 0 };
let session: Session | undefined;
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
  const before = process.memoryUsage();
  const startedAt = Date.now();
  try {
    if (bun) {
      bun.gc(true);
    } else {
      if (!session) {
        const connection = new Session();
        connection.connect();
        // Keep the local session until worker teardown. Disconnecting during GC
        // completion deadlocks V8 and tears down other profiler state.
        session = connection;
      }
      await session.post("HeapProfiler.collectGarbage");
    }
    // A task overlapping collection can leave garbage until the next idle growth sample.
    collectedMemory = process.memoryUsage();
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= SLOW_IDLE_GC_MS) {
      // The forced collection blocks this thread, so requests posted meanwhile show
      // only as slow broker delivery; name the pause instead.
      const fields = {
        elapsedMs,
        threadId,
        heapUsedBeforeBytes: before.heapUsed,
        heapUsedAfterBytes: collectedMemory.heapUsed,
        externalBeforeBytes: before.external,
        externalAfterBytes: collectedMemory.external,
      };
      // Every pool worker loads this module; load logging only on this rare path so
      // small workers stay inside their evaluated-module budgets.
      void import("./worker-idle-gc-report.runtime.js")
        .then(({ reportSlowIdleWorkerGc }) => reportSlowIdleWorkerGc(fields))
        .catch((error: unknown) => {
          process.emitWarning(error instanceof Error ? error : String(error));
        });
    }
  } catch (error) {
    process.emitWarning(error instanceof Error ? error : String(error));
  } finally {
    collecting = false;
  }
}

/** Only native worker owners call this after releasing their operation's payloads. */
export function scheduleWorkerIdleGc(): void {
  if (isMainThread || pending || collecting) {
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
