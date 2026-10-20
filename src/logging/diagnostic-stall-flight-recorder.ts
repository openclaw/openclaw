import { performance } from "node:perf_hooks";
import { versions } from "node:process";
import * as v8 from "node:v8";
import { isMainThread } from "node:worker_threads";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import {
  hasProfilerConflict,
  parseNativeCpuProfile,
  sanitizeDiagnosticProfileFrame,
} from "./diagnostic-profile.js";

const WINDOW_MS = 5_000;
const SAMPLE_MS = 10;
const MAX_SAMPLES = 1_024;
const MAX_PROFILE_BYTES = 1_048_576;

/** Two short native profiles retain recent stacks without a listener or on-demand heap scan. */
export function createStallFlightRecorder(
  warn: (message: string) => void,
  now: () => number = () => performance.now(),
) {
  let active: v8.SyncCPUProfileHandle | undefined;
  let previous: { json: string; endedAt: number } | undefined;
  let startedAt = 0;
  let disabled = !isMainThread || Boolean(versions.bun) || Number(versions.node.split(".")[0]) < 26;
  let packageRoot: string | null = null;
  const stop = () => {
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
  try {
    if (!disabled) {
      disabled =
        hasProfilerConflict() ||
        Boolean(process.getBuiltinModule("inspector")?.url()) ||
        Boolean(process.getBuiltinModule("trace_events")?.getEnabledCategories());
    }
    if (!disabled) {
      packageRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
      active = start();
      startedAt = now();
    }
  } catch {
    disabled = true;
    warn("stall flight recorder unavailable: profiler-start-failed");
  }
  return {
    sample(stallMs = 0): string | undefined {
      if (disabled || !active || (stallMs === 0 && now() - startedAt < WINDOW_MS)) {
        return undefined;
      }
      try {
        const old = active;
        // Keep the native code map and sampler alive; restarting the last profile scans the heap.
        active = start();
        startedAt = now();
        const current = { json: old.stop(), endedAt: now() };
        const windows = previous ? [previous, current] : [current];
        previous = current.json.length <= MAX_PROFILE_BYTES ? current : undefined;
        if (!stallMs) {
          return undefined;
        }
        const counts = new Map<string, number>();
        let samples = 0;
        let truncated = false;
        for (const window of windows) {
          if (window.json.length > MAX_PROFILE_BYTES) {
            truncated = true;
            continue;
          }
          const profile = parseNativeCpuProfile(window.json);
          const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
          const parents = new Map<number, number>();
          for (const node of profile.nodes) {
            for (const child of node.children ?? []) {
              parents.set(child, node.id);
            }
          }
          let at = profile.startTime;
          const cutoff = profile.endTime - (stallMs + 100 - (now() - window.endedAt)) * 1_000;
          truncated ||= (profile.samples?.length ?? 0) >= MAX_SAMPLES;
          for (const [index, id] of (profile.samples ?? []).entries()) {
            at += profile.timeDeltas?.[index] ?? 0;
            if (at < cutoff) {
              continue;
            }
            samples++;
            const seen = new Set<string>();
            let cursor: number | undefined = id;
            while (cursor !== undefined) {
              const node = nodes.get(cursor);
              if (!node) {
                break;
              }
              const { callFrame: frame } = sanitizeDiagnosticProfileFrame(
                node.callFrame,
                packageRoot,
              );
              if (
                frame.url ||
                frame.functionName === "[native]" ||
                frame.functionName === "(garbage collector)"
              ) {
                const label =
                  `${frame.functionName || "(anonymous)"}@${frame.url}:${frame.lineNumber + 1}`.slice(
                    0,
                    240,
                  );
                if (!seen.has(label)) {
                  seen.add(label);
                  counts.set(label, (counts.get(label) ?? 0) + 1);
                }
              }
              cursor = parents.get(cursor);
            }
          }
        }
        const frames = [...counts].toSorted((a, b) => b[1] - a[1]).slice(0, 8);
        return `windowMs=${Math.round(stallMs + 100)} samples=${samples} intervalMs=${SAMPLE_MS} truncated=${truncated} inclusive=${JSON.stringify(frames)}`;
      } catch {
        stop();
        warn("stall flight recorder unavailable: profiler-capture-failed");
        return undefined;
      }
    },
    stop,
  };
}
