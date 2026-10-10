import { getHeapStatistics } from "node:v8";
import { MessageChannel, type MessagePort } from "node:worker_threads";

/** Publish isolate-local counters without sharing the task transport or keeping it alive. */
export function serveWorkerMemorySamples(parent: MessagePort): void {
  const { port1, port2 } = new MessageChannel();
  const heapSizeLimitBytes = process.versions.bun ? undefined : getHeapStatistics().heap_size_limit;
  const sample = () => {
    const { heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage();
    port1.postMessage({ heapUsed, heapTotal, external, arrayBuffers, heapSizeLimitBytes });
  };
  port1.on("message", sample);
  port1.on("messageerror", () => port1.close());
  port1.unref();
  sample();
  parent.postMessage({ status: "memory", port: port2 }, [port2]);
}
