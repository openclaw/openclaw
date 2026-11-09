import { performance } from "node:perf_hooks";
import { versions } from "node:process";
import * as v8 from "node:v8";
import { isMainThread } from "node:worker_threads";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { hasProfilerConflict } from "./diagnostic-profile.js";
import { createStallKernelRecorder } from "./diagnostic-stall-kernel.js";
import {
  formatStallProfile,
  MAX_PROFILE_BYTES,
  MAX_SAMPLES,
  SAMPLE_MS,
  type StallProfileWindow,
  type StallProfileSnapshot,
} from "./diagnostic-stall-profile.js";

const WINDOW_MS = 5_000;

/** Two short native profiles retain recent stacks without a listener or on-demand heap scan. */
export function createStallFlightRecorder(warn: (message: string) => void) {
  const packageRoot = isMainThread
    ? resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url })
    : null;
  const kernel = createStallKernelRecorder(warn, packageRoot);
  let active: v8.SyncCPUProfileHandle | undefined;
  let previous: StallProfileWindow | undefined;
  let startedAt = 0;
  let disabled = !isMainThread || Boolean(versions.bun) || Number(versions.node.split(".")[0]) < 26;
  const captureSymbol = Symbol.for("openclaw.stallFlightRecorder.capture");
  const stopProfile = () => {
    if (Object.getOwnPropertyDescriptor(globalThis, captureSymbol)?.value === capture) {
      Reflect.deleteProperty(globalThis, captureSymbol);
    }
    disabled = true;
    previous = undefined;
    const handle = active;
    active = undefined;
    try {
      handle?.[Symbol.dispose]();
    } catch {
      warn("stall flight recorder unavailable: profiler-cleanup-failed");
    }
  };
  const start = () => v8.startCpuProfile({ sampleInterval: SAMPLE_MS, maxBufferSize: MAX_SAMPLES });
  const capture = (): StallProfileSnapshot | undefined => {
    if (disabled || !active) {
      return undefined;
    }
    const captureStartedAt = performance.now();
    const old = active;
    // Keep the native code map and sampler alive; restarting the last profile scans the heap.
    active = start();
    startedAt = performance.now();
    // Native endTime precedes serialization; anchoring afterward shifts samples forward.
    const endedAt = performance.now();
    const json = old.stop();
    const current = { json: json.length <= MAX_PROFILE_BYTES ? json : undefined, endedAt };
    const windows = previous ? [previous, current] : [current];
    previous = current.json === undefined ? undefined : current;
    return { windows, endedAt, captureMs: performance.now() - captureStartedAt };
  };
  try {
    if (!disabled) {
      disabled =
        hasProfilerConflict() ||
        Boolean(process.getBuiltinModule("inspector")?.url()) ||
        Boolean(process.getBuiltinModule("trace_events")?.getEnabledCategories());
    }
    if (!disabled) {
      active = start();
      startedAt = performance.now();
      // Inspector interrupts can obtain the bounded native snapshot while ordinary JS is stuck.
      // Parsing and output stay in the observer; no inspector listener is opened.
      Object.defineProperty(globalThis, captureSymbol, { configurable: true, value: capture });
    }
  } catch {
    disabled = true;
    warn("stall flight recorder unavailable: profiler-start-failed");
  }
  return {
    sample(stall?: { startedAt: number; endedAt: number; task?: string }): string | undefined {
      const kernelSummary = kernel?.take(stall) ?? "";
      if (!stall && performance.now() - startedAt < WINDOW_MS) {
        return undefined;
      }
      try {
        const snapshot = capture();
        if (stall && snapshot) {
          return formatStallProfile(snapshot.windows, stall, packageRoot, kernelSummary);
        }
      } catch {
        stopProfile();
        warn("stall flight recorder unavailable: profiler-capture-failed");
      }
      return stall && kernelSummary
        ? formatStallProfile([], stall, packageRoot, kernelSummary)
        : undefined;
    },
    stop() {
      kernel?.stop();
      stopProfile();
    },
  };
}
