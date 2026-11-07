import { url as inspectorUrl } from "node:inspector";
import { performance } from "node:perf_hooks";
import { isMainThread, MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "../infra/runtime-worker-url.js";
import { hasProfilerConflict } from "./diagnostic-profile.js";

type KernelSample = {
  at: number;
  state: string;
  wchan: string;
  syscall: string;
  stack?: string;
  io?: number[];
  ctxt?: number[];
  rssKb?: number[];
  psi?: number[][];
  sched?: number[];
};

/** Capture live kernel evidence without waiting for the main thread or blocking the observer. */
export function createStallKernelRecorder(
  warn: (message: string) => void,
  packageRoot: string | null,
) {
  if (!isMainThread) {
    return undefined;
  }
  const heartbeat = new BigInt64Array(new SharedArrayBuffer(16));
  const profiling = hasProfilerConflict();
  const beat = () => {
    Atomics.store(heartbeat, 1, profiling || inspectorUrl() ? 1n : 0n);
    Atomics.store(heartbeat, 0, BigInt(Math.floor(performance.now())));
  };
  beat();
  const { port1, port2 } = new MessageChannel();
  let worker: Worker | undefined;
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    clearInterval(timer);
    port1.close();
    port2.close();
    void worker?.terminate();
  };
  try {
    const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.stallObserver);
    worker = new Worker(workerUrl, {
      execArgv: resolveRuntimeWorkerThreadExecArgv(workerUrl),
      workerData: {
        heartbeat: heartbeat.buffer,
        port: port2,
        packageRoot,
        timeOrigin: performance.timeOrigin,
      },
      transferList: [port2],
    });
    worker.on("error", () => {
      stop();
      warn("stall kernel recorder unavailable: worker-failed");
    });
    worker.unref();
    timer = setInterval(beat, 250);
    timer.unref();
  } catch {
    stop();
    warn("stall kernel recorder unavailable: worker-start-failed");
    return undefined;
  }
  return {
    take(stall?: { startedAt: number; endedAt: number }) {
      const samples: KernelSample[] = [];
      let received: ReturnType<typeof receiveMessageOnPort>;
      // Drain synchronously: the health timer can run before queued worker message callbacks.
      while ((received = receiveMessageOnPort(port1))) {
        const sample: KernelSample = received.message;
        if (
          stall &&
          sample.at >= stall.startedAt &&
          sample.at <= stall.endedAt &&
          samples.length < 3
        ) {
          sample.at = Math.round(sample.at - stall.startedAt);
          samples.push(sample);
        }
      }
      if (!samples.length) {
        return "";
      }
      // Preserve all state/wchan observations; shed counter detail before exceeding the log budget.
      let result = JSON.stringify(samples);
      for (const key of ["psi", "io", "ctxt", "rssKb", "stack", "sched"] as const) {
        if (Buffer.byteLength(result) <= 1_400) {
          break;
        }
        for (const sample of samples) {
          delete sample[key];
        }
        result = JSON.stringify(samples);
      }
      return ` kernel=${result}`;
    },
    stop,
  };
}
