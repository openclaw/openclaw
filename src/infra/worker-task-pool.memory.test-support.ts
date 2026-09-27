import assert from "node:assert/strict";
import { Session } from "node:inspector";
import { constants, PerformanceObserver } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { MessagePort, resourceLimits, threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { serveWorkerTasks } from "./worker-task-server.js";

// Keep the inspector until worker teardown; disconnecting in its GC callback can deadlock V8.
let baselineInspector: Session | undefined;

serveWorkerTasks(async (input) => {
  assert.ok(isRecord(input));
  if (input.receipt instanceof MessagePort) {
    const receipt = input.receipt;
    const payload =
      input.allocate === true ? Array.from({ length: 16 * 1024 * 1024 }, () => 37) : undefined;
    const before = getHeapStatistics().used_heap_size;
    let gcMs: number | undefined;
    const observer = new PerformanceObserver((list) => {
      const major = list
        .getEntries()
        .find(
          (entry) =>
            "detail" in entry &&
            isRecord(entry.detail) &&
            entry.detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR,
        );
      if (major) {
        gcMs = major.duration;
      }
    });
    observer.observe({ entryTypes: ["gc"] });
    // Let the handler unwind and the owner's idle immediate run before sampling.
    setImmediate(() =>
      setImmediate(() => {
        observer.disconnect();
        receipt.postMessage({ heap: getHeapStatistics().used_heap_size, gcMs, threadId }, []);
        receipt.close();
      }),
    );
    return {
      heap: before,
      checksum: payload ? payload[0]! + payload.at(-1)! : undefined,
      threadId,
      resourceLimits,
    };
  }
  if (!baselineInspector) {
    // Remove startup garbage before measuring the later allocation growth.
    const session = new Session();
    session.connect();
    baselineInspector = session;
    await new Promise<void>((resolve, reject) => {
      session.post("HeapProfiler.collectGarbage", (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
  return { heap: getHeapStatistics().used_heap_size, threadId, resourceLimits };
});
