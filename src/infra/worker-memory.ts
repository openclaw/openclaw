import { getHeapSpaceStatistics, getHeapStatistics } from "node:v8";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { WorkerGcProfiles } from "../logging/diagnostic-worker-gc-profile.js";
import type { DiagnosticWorkerRetainedData } from "./diagnostic-process-types.js";
import {
  flushGcSamples,
  getOldGenerationAfterGcBytes,
  observeGcSamples,
  type GcSample,
} from "./gc-observer.js";

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
  captureStatus?: "requested" | "complete" | "unavailable";
  captureReason?: string;
  profiles?: WorkerGcProfiles;
};

let diagnosticPort: MessagePort | undefined;
let nextGcProfileAt = 0;

/** Isolate-local diagnostics use the memory channel even while a task is parked. */
export function publishWorkerGcStorm(gcStorm: WorkerGcStorm | { retireWorkerId: string }): void {
  if (!diagnosticPort) {
    return;
  }
  if ("retireWorkerId" in gcStorm) {
    diagnosticPort.postMessage(gcStorm, []);
    return;
  }
  if (performance.now() >= nextGcProfileAt) {
    // Reserve before any async admission/import; failures also consume the hourly attempt.
    nextGcProfileAt = performance.now() + 60 * 60_000;
    gcStorm.captureStatus = "requested";
  }
  diagnosticPort.postMessage({ gcStorm }, []);
}

const MAX_PENDING_GC_SAMPLES = 256;

/** Publish isolate-local counters without sharing the task transport or keeping it alive. */
export function serveWorkerMemorySamples(
  parent: MessagePort,
  retainedData?: () => readonly DiagnosticWorkerRetainedData[],
) {
  const { port1, port2 } = new MessageChannel();
  diagnosticPort = port1;
  const heapSizeLimitBytes = process.versions.bun ? undefined : getHeapStatistics().heap_size_limit;
  let gc: GcSample[] | undefined;
  let taskMetrics = false;
  const flushGc = () => {
    if (gc) {
      port1.postMessage({ gc });
      gc = undefined;
    }
  };
  const sample = () => {
    const { heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage();
    const heapSpaces = process.versions.bun
      ? undefined
      : getHeapSpaceStatistics().map(({ space_name, space_used_size }) => ({
          space_name,
          space_used_size,
        }));
    port1.postMessage({
      heapUsed,
      heapTotal,
      external,
      arrayBuffers,
      heapSizeLimitBytes,
      oldGenerationAfterGcBytes: getOldGenerationAfterGcBytes(),
      heapSpaces,
      retainedData: retainedData?.(),
      gc,
    });
    gc = undefined;
  };
  let stopGc: (() => void) | undefined;
  const setGcEnabled = (enabled: boolean) => {
    if (enabled) {
      stopGc ??= observeGcSamples((samples) => {
        (gc ??= []).push(...samples);
        // Pool workers can retire between heartbeats. Use the existing native sampler's cadence.
        if (taskMetrics || gc.length >= MAX_PENDING_GC_SAMPLES) {
          flushGc();
        }
      });
    } else {
      stopGc?.();
      stopGc = undefined;
      gc = undefined;
    }
  };
  port1.on(
    "message",
    (
      request: { gc: boolean } | { flush: true } | { captureGcProfile: WorkerGcStorm } | undefined,
    ) => {
      if (request && "flush" in request) {
        flushGcSamples();
        flushGc();
        // Only this heap counter survives retirement; RSS, spaces and retained data do not.
        port1.postMessage({ flushed: true, heapUsed: getHeapStatistics().used_heap_size });
        return;
      }
      if (request && "captureGcProfile" in request) {
        const storm = request.captureGcProfile;
        void import("../logging/diagnostic-worker-gc-profile.js")
          .then(({ captureWorkerGcProfiles }) => captureWorkerGcProfiles())
          .then((outcome) => {
            port1.postMessage({
              gcStorm:
                outcome.status === "complete"
                  ? { ...storm, captureStatus: "complete", profiles: outcome.result }
                  : { ...storm, captureStatus: "unavailable", captureReason: outcome.reason },
            });
          })
          .catch(() => {
            port1.postMessage({
              gcStorm: { ...storm, captureStatus: "unavailable", captureReason: "capture-failed" },
            });
          });
        return;
      }
      if (request) {
        setGcEnabled(request.gc);
      } else {
        sample();
      }
    },
  );
  port1.once("close", () => {
    diagnosticPort = undefined;
    stopGc?.();
    gc = undefined;
  });
  port1.on("messageerror", () => port1.close());
  port1.unref();
  sample();
  parent.postMessage({ status: "memory", port: port2 }, [port2]);
  return {
    setTaskMetrics(enabled: boolean) {
      taskMetrics = enabled;
      setGcEnabled(enabled);
    },
    collectTask(): true | undefined {
      return taskMetrics ? true : undefined;
    },
    close(this: void) {
      diagnosticPort = undefined;
      stopGc?.();
      stopGc = undefined;
      flushGc();
      port1.close();
    },
  };
}
