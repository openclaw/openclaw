import assert from "node:assert/strict";
import { getHeapStatistics } from "node:v8";
import { MessagePort, resourceLimits, threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { serveWorkerTasks } from "./worker-task-server.js";

const collectedPayloads = new FinalizationRegistry<MessagePort>((receipt) => {
  receipt.postMessage(
    {
      heap: getHeapStatistics().used_heap_size,
      external: process.memoryUsage().external,
      threadId,
    },
    [],
  );
  receipt.close();
});

serveWorkerTasks((input) => {
  assert.ok(isRecord(input));
  if (input.receipt instanceof MessagePort) {
    const receipt = input.receipt;
    const payload =
      input.external === true
        ? Buffer.alloc(64 * 1024 * 1024, 37)
        : Array.from({ length: 16 * 1024 * 1024 }, () => 37);
    const before = getHeapStatistics().used_heap_size;
    // Bun does not emit perf_hooks GC entries; acknowledge this payload's actual collection.
    collectedPayloads.register(payload, receipt);
    return {
      heap: before,
      external: process.memoryUsage().external,
      checksum: payload[0]! + payload.at(-1)!,
      threadId,
      resourceLimits,
    };
  }
  return {
    heap: getHeapStatistics().used_heap_size,
    external: process.memoryUsage().external,
    threadId,
    resourceLimits,
  };
});
