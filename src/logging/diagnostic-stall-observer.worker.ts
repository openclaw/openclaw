import { writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { workerData, type MessagePort } from "node:worker_threads";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import type { StallProfileSnapshot } from "./diagnostic-stall-profile.js";

// SAFETY: createStallKernelRecorder is the sole launcher and owns this transferred payload.
const { heartbeat, port, packageRoot } = workerData as {
  heartbeat: SharedArrayBuffer;
  port: MessagePort;
  packageRoot: string | null;
};
const clock = new BigInt64Array(heartbeat);
// Linux's thread-group leader is the process PID, not worker_threads.threadId.
const task = `/proc/self/task/${process.pid}/`;
const buffer = Buffer.alloc(4096);
async function read(path: string) {
  try {
    const file = await open(path, "r");
    try {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      await file.close();
    }
  } catch (error) {
    return `?${extractErrorCode(error)}`;
  }
}
const numbers = (text: string, pattern: RegExp) =>
  [...text.matchAll(pattern)].map((match) => Number(match[1]));
let observed = 0n;
let attempts = 0;
let nextKernelAt = 0;
let nextReportAt = 0;
let kernelPending = false;
let reportPending = false;

async function sampleKernel(beat: bigint, at: number) {
  kernelPending = true;
  attempts++;
  nextKernelAt = at + 1000;
  try {
    const stat = await read(task + "stat");
    const wchan = (await read(task + "wchan")).trim().slice(0, 64);
    // Retain only the syscall number, never arguments, pointers, or user data.
    const syscall = (await read(task + "syscall")).trim().split(/\s+/)[0];
    const rawStack = await read(task + "stack");
    const stack = rawStack.startsWith("?")
      ? rawStack
      : [...rawStack.matchAll(/\] ([\w.]+)/g)]
          .slice(0, 3)
          .map((match) => match[1])
          .join(",")
          .slice(0, 96);
    const io = numbers(await read(task + "io"), /:\s*(\d+)/g);
    const status = await read("/proc/self/status");
    const ctxt = numbers(status, /(?:^|\n)(?:non)?voluntary_ctxt_switches:\s*(\d+)/g);
    const rssKb = numbers(status, /VmRSS:\s*(\d+)/g);
    const psi = [];
    for (const resource of ["io", "memory", "cpu"]) {
      psi.push(numbers(await read("/proc/pressure/" + resource), /total=(\d+)/g));
    }
    const sched = numbers(await read(task + "schedstat"), /(?:^|\s)(\d+)/g).slice(0, 2);
    if (Atomics.load(clock, 0) === beat) {
      port.postMessage({
        at,
        state: stat.startsWith("?")
          ? stat
          : stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3),
        wchan,
        syscall,
        stack,
        io,
        ctxt,
        rssKb,
        psi,
        sched,
      });
    }
  } finally {
    kernelPending = false;
  }
}

async function reportStall(beat: bigint, at: number) {
  reportPending = true;
  nextReportAt = at + 60_000;
  const session = new Session();
  try {
    session.connectToMainThread();
    // Starting a fresh Profiler during a spin can omit the already executing leaf.
    // Interrupt only to rotate the existing bounded native recorder, then format here.
    const { result, exceptionDetails } = await session.post("Runtime.evaluate", {
      expression: 'globalThis[Symbol.for("openclaw.stallFlightRecorder.capture")]?.()',
      returnByValue: true,
    });
    if (exceptionDetails || result.type !== "object") {
      throw new Error("capture unavailable");
    }
    // SAFETY: The private capture Symbol returns this owner-typed snapshot, serialized by value.
    const snapshot = result.value as StallProfileSnapshot;
    const { formatStallProfile } = await import("./diagnostic-stall-profile.js");
    const report = formatStallProfile(
      snapshot.windows,
      { startedAt: Number(beat), endedAt: snapshot.endedAt },
      packageRoot,
    );
    // Worker stdout/stderr streams relay through the main event loop. The OS fd does not.
    writeSync(
      2,
      `[gateway/event-loop] main-thread stall in progress: captureMs=${snapshot.captureMs.toFixed(1)} ${report}\n`,
    );
  } catch {
    writeSync(
      2,
      `[gateway/event-loop] main-thread stall in progress: elapsedMs=${Math.round(at - Number(beat))} profile=unavailable\n`,
    );
  } finally {
    session.disconnect();
    reportPending = false;
  }
}

setInterval(() => {
  const beat = Atomics.load(clock, 0);
  const at = performance.now();
  if (beat !== observed) {
    observed = beat;
    attempts = 0;
    nextKernelAt = Number(beat) + 1000;
    nextReportAt = Number(beat) + 30_000;
  }
  if (process.platform === "linux" && !kernelPending && attempts < 3 && at >= nextKernelAt) {
    void sampleKernel(beat, at);
  }
  if (!reportPending && at >= nextReportAt) {
    void reportStall(beat, at);
  }
}, 250);
