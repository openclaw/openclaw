import { getHeapStatistics } from "node:v8";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { observeGcSamples, type GcSample } from "./gc-observer.js";

export type WorkerGcStorm = {
  workerId?: string;
  runId?: string;
  sessionKeyHash?: string;
  cellCount: number;
  activeCellCount: number;
  bridgeMethods: string[];
  majorCollections: number;
  intervalMs: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  heapSizeLimitBytes: number;
};

let diagnosticPort: MessagePort | undefined;

/** Isolate-local diagnostics use the memory channel even while a task is parked. */
export function publishWorkerGcStorm(gcStorm: WorkerGcStorm): void {
  diagnosticPort?.postMessage({ gcStorm }, []);
}

const MAX_PENDING_GC_SAMPLES = 256;

/** Publish isolate-local counters without sharing the task transport or keeping it alive. */
export function serveWorkerMemorySamples(parent: MessagePort): () => void {
  const { port1, port2 } = new MessageChannel();
  diagnosticPort = port1;
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
    diagnosticPort = undefined;
    stopGc?.();
    gc = undefined;
  });
  port1.on("messageerror", () => port1.close());
  port1.unref();
  sample();
  parent.postMessage({ status: "memory", port: port2 }, [port2]);
  return () => {
    diagnosticPort = undefined;
    stopGc?.();
    flushGc();
    port1.close();
  };
}
