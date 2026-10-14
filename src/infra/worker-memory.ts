import { getHeapStatistics } from "node:v8";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { observeGcSamples, type GcSample } from "./gc-observer.js";

const MAX_PENDING_GC_SAMPLES = 256;

/** Publish isolate-local counters without sharing the task transport or keeping it alive. */
export function serveWorkerMemorySamples(parent: MessagePort): () => void {
  const { port1, port2 } = new MessageChannel();
  const heapSizeLimitBytes = process.versions.bun ? undefined : getHeapStatistics().heap_size_limit;
  let gc: GcSample[] | undefined;
  const flushGc = () => {
    if (gc) {
      port1.postMessage({ gc });
      gc = undefined;
    }
  };
  const sample = () => {
    const { heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage();
    port1.postMessage({ heapUsed, heapTotal, external, arrayBuffers, heapSizeLimitBytes, gc });
    gc = undefined;
  };
  let stopGc: (() => void) | undefined;
  port1.on("message", (request: { gc: boolean } | undefined) => {
    if (request) {
      if (request.gc) {
        // The heartbeat already requests memory every 30 seconds; carry GC events with it.
        stopGc ??= observeGcSamples((samples) => {
          (gc ??= []).push(...samples);
          // A stalled host must not make this worker retain an unbounded interval.
          if (gc.length >= MAX_PENDING_GC_SAMPLES) {
            flushGc();
          }
        });
      } else {
        stopGc?.();
        stopGc = undefined;
        gc = undefined;
      }
    } else {
      sample();
    }
  });
  port1.once("close", () => {
    stopGc?.();
    gc = undefined;
  });
  port1.on("messageerror", () => port1.close());
  port1.unref();
  sample();
  parent.postMessage({ status: "memory", port: port2 }, [port2]);
  return () => {
    stopGc?.();
    flushGc();
    port1.close();
  };
}
