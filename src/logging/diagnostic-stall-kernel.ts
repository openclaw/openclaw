import { performance } from "node:perf_hooks";
import { isMainThread, MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";

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

// Builtins only: this observer must start without importing the Gateway or its worker pools.
const SOURCE = String.raw`
const { workerData } = require('node:worker_threads');
const { open } = require('node:fs/promises');
const { performance } = require('node:perf_hooks');
const { heartbeat, port } = workerData;
const clock = new BigInt64Array(heartbeat);
// Linux's thread-group leader is the process PID, not worker_threads.threadId.
const task = '/proc/self/task/' + process.pid + '/';
const buffer = Buffer.alloc(4096);
async function read(path) {
  try {
    const file = await open(path, 'r');
    try {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return buffer.toString('utf8', 0, bytesRead);
    } finally { await file.close(); }
  } catch (error) { return '?' + error.code; }
}
const numbers = (text, pattern) => [...text.matchAll(pattern)].map(match => Number(match[1]));
let observed = 0n, attempts = 0, nextAt = 0, pending = false;
setInterval(async () => {
  const beat = Atomics.load(clock, 0);
  const at = performance.now();
  if (beat !== observed) {
    observed = beat;
    attempts = 0;
    nextAt = Number(beat) + 1000;
  }
  if (pending || attempts === 3 || at < nextAt) return;
  pending = true;
  attempts++;
  nextAt = at + 1000;
  try {
    const stat = await read(task + 'stat');
    const wchan = (await read(task + 'wchan')).trim().slice(0, 64);
    // Retain only the syscall number, never arguments, pointers, or user data.
    const syscall = (await read(task + 'syscall')).trim().split(/\s+/)[0];
    const rawStack = await read(task + 'stack');
    const stack = rawStack.startsWith('?') ? rawStack :
      [...rawStack.matchAll(/\] ([\w.]+)/g)].slice(0, 3).map(match => match[1]).join(',').slice(0, 96);
    const io = numbers(await read(task + 'io'), /:\s*(\d+)/g);
    const status = await read('/proc/self/status');
    const ctxt = numbers(status, /(?:^|\n)(?:non)?voluntary_ctxt_switches:\s*(\d+)/g);
    const rssKb = numbers(status, /VmRSS:\s*(\d+)/g);
    const psi = [];
    for (const resource of ['io', 'memory', 'cpu']) {
      psi.push(numbers(await read('/proc/pressure/' + resource), /total=(\d+)/g));
    }
    const sched = numbers(await read(task + 'schedstat'), /(?:^|\s)(\d+)/g).slice(0, 2);
    if (Atomics.load(clock, 0) === beat) {
      port.postMessage({ at, state: stat.startsWith('?') ? stat : stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3),
        wchan, syscall, stack, io, ctxt, rssKb, psi, sched });
    }
  } finally { pending = false; }
}, 250);
`;

/** Capture live kernel evidence without waiting for the main thread or blocking the observer. */
export function createStallKernelRecorder(warn: (message: string) => void) {
  if (process.platform !== "linux" || !isMainThread) {
    return undefined;
  }
  const heartbeat = new BigInt64Array(new SharedArrayBuffer(8));
  const beat = () => Atomics.store(heartbeat, 0, BigInt(Math.floor(performance.now())));
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
    worker = new Worker(SOURCE, {
      eval: true,
      execArgv: [],
      workerData: { heartbeat: heartbeat.buffer, port: port2 },
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
