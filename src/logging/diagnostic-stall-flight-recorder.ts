import { performance } from "node:perf_hooks";
import { versions } from "node:process";
import { getCallSites } from "node:util";
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

/** Retain bounded native profiles or interrupted stacks without a debugger listener. */
export function createStallFlightRecorder(warn: (message: string) => void) {
  const packageRoot = isMainThread
    ? resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url })
    : null;
  const kernel = createStallKernelRecorder(warn, packageRoot);
  let active: v8.SyncCPUProfileHandle | undefined;
  let previous: StallProfileWindow | undefined;
  let startedAt = 0;
  const native = Number(versions.node.split(".")[0]) >= 26;
  let disabled = !isMainThread || Boolean(versions.bun);
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
    if (disabled) {
      return undefined;
    }
    const captureStartedAt = performance.now();
    if (!native) {
      // Node 24's native profiler ignores interval/buffer options. Interrupt only
      // to snapshot the executing stack, without enabling a profiler or debugger.
      if (
        hasProfilerConflict() ||
        process.getBuiltinModule("inspector")?.url() ||
        process.getBuiltinModule("trace_events")?.getEnabledCategories()
      ) {
        return undefined;
      }
      const frames = getCallSites(18, { sourceMap: false })
        .slice(2)
        .map((frame) => ({
          functionName: frame.functionName.length <= 256 ? frame.functionName : "[redacted]",
          scriptId: frame.scriptId,
          url: frame.scriptName.length <= 2_048 ? frame.scriptName : "",
          lineNumber: frame.lineNumber - 1,
          columnNumber: frame.columnNumber - 1,
        }));
      return {
        windows: [],
        stacks: [{ at: captureStartedAt, frames }],
        endedAt: captureStartedAt,
        captureMs: performance.now() - captureStartedAt,
      };
    }
    if (!active) {
      return undefined;
    }
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
      if (native) {
        active = start();
        startedAt = performance.now();
      }
      // Inspector interrupts capture bounded evidence while ordinary JS is stuck.
      // Parsing and output stay in the observer; no inspector listener is opened.
      Object.defineProperty(globalThis, captureSymbol, { configurable: true, value: capture });
    }
  } catch {
    disabled = true;
    warn("stall flight recorder unavailable: profiler-start-failed");
  }
  return {
    sample(stall?: { startedAt: number; endedAt: number; task?: string }): string | undefined {
      const { kernelSummary = "", stacks = [] } = kernel?.take(stall) ?? {};
      if (!stall && performance.now() - startedAt < WINDOW_MS) {
        return undefined;
      }
      try {
        const snapshot = active ? capture() : undefined;
        if (stall && snapshot) {
          return formatStallProfile(snapshot.windows, stall, packageRoot, kernelSummary);
        }
      } catch {
        stopProfile();
        warn("stall flight recorder unavailable: profiler-capture-failed");
      }
      return stall && (kernelSummary || stacks.length)
        ? formatStallProfile([], stall, packageRoot, kernelSummary, stacks)
        : undefined;
    },
    stop() {
      kernel?.stop();
      stopProfile();
    },
  };
}
