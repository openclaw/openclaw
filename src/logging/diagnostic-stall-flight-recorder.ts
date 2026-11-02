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
import { createStallKernelRecorder } from "./diagnostic-stall-kernel.js";

const WINDOW_MS = 5_000;
const SAMPLE_MS = 25;
const MAX_SAMPLES = 1_024;
const MAX_PROFILE_BYTES = 1_048_576;
const MAX_REPORT_BYTES = 2_048;

type SelfFrame = { frame: string; app: string | null; samples: number; timeUs: number };
type SampledStack = { frames: string[]; samples: number; timeUs: number };

function formatStallFrames(
  header: string,
  counts: Map<string, number>,
  selfFrames: Map<string, SelfFrame>,
  stacks: Map<string, SampledStack>,
) {
  const inclusive = [...counts].toSorted((a, b) => b[1] - a[1]).slice(0, 8);
  const self = [...selfFrames.values()]
    .toSorted((a, b) => b.timeUs - a.timeUs || b.samples - a.samples)
    .slice(0, 10)
    .map(({ frame, samples, timeUs, app }) => [frame, samples, Math.round(timeUs / 100) / 10, app]);
  const deepest: Array<[number, string[]]> = [...stacks.values()]
    .toSorted((a, b) => b.timeUs - a.timeUs || b.samples - a.samples)
    .slice(0, 3)
    .map(({ samples, frames }) => [samples, frames]);
  let reportTruncated = false;
  const render = () =>
    `${header} inclusive=${JSON.stringify(inclusive)} reportTruncated=${reportTruncated} self=${JSON.stringify(self)} deepest=${JSON.stringify(deepest)}`;
  let report = render();
  // Keep the hottest caller and leaf together; omit lower-ranked samples first.
  while (Buffer.byteLength(report) > MAX_REPORT_BYTES) {
    reportTruncated = true;
    if (inclusive.length) {
      inclusive.pop();
    } else if (deepest.length > 1) {
      deepest.pop();
    } else if (self.length > 1) {
      self.pop();
    } else if ((deepest[0]?.[1].length ?? 0) > 3) {
      deepest[0]![1].splice(1, 2, "[...]");
    } else if (self.length) {
      self.pop();
    } else {
      deepest.pop();
    }
    report = render();
  }
  return report;
}

/** Two short native profiles retain recent stacks without a listener or on-demand heap scan. */
export function createStallFlightRecorder(warn: (message: string) => void) {
  let kernel: ReturnType<typeof createStallKernelRecorder>;
  let active: v8.SyncCPUProfileHandle | undefined;
  let previous: { json: string; endedAt: number } | undefined;
  let startedAt = 0;
  let disabled = !isMainThread || Boolean(versions.bun) || Number(versions.node.split(".")[0]) < 26;
  let packageRoot: string | null = null;
  const stop = () => {
    kernel?.stop();
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
      startedAt = performance.now();
      kernel = createStallKernelRecorder(warn);
    }
  } catch {
    disabled = true;
    warn("stall flight recorder unavailable: profiler-start-failed");
  }
  return {
    sample(stall?: { startedAt: number; endedAt: number; task?: string }): string | undefined {
      const kernelSummary = kernel?.take(stall) ?? "";
      if (disabled || !active || (!stall && performance.now() - startedAt < WINDOW_MS)) {
        return undefined;
      }
      try {
        const old = active;
        // Keep the native code map and sampler alive; restarting the last profile scans the heap.
        active = start();
        startedAt = performance.now();
        // Native endTime precedes serialization; anchoring afterward shifts samples forward.
        const endedAt = performance.now();
        const current = { json: old.stop(), endedAt };
        const windows = previous ? [previous, current] : [current];
        previous = current.json.length <= MAX_PROFILE_BYTES ? current : undefined;
        if (!stall) {
          return undefined;
        }
        const counts = new Map<string, number>();
        const selfFrames = new Map<string, SelfFrame>();
        const stacks = new Map<string, SampledStack>();
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
          const from = profile.endTime + (stall.startedAt - window.endedAt) * 1_000;
          const to = profile.endTime + (stall.endedAt - window.endedAt) * 1_000;
          truncated ||= (profile.samples?.length ?? 0) >= MAX_SAMPLES;
          const leaves = new Map<number, { samples: number; timeUs: number }>();
          for (const [index, id] of (profile.samples ?? []).entries()) {
            const delta = profile.timeDeltas?.[index] ?? 0;
            at += delta;
            if (at < from || at > to) {
              continue;
            }
            samples++;
            const leaf = leaves.get(id) ?? { samples: 0, timeUs: 0 };
            leaf.samples++;
            leaf.timeUs += Math.min(delta, at - from);
            leaves.set(id, leaf);
          }
          // Walk each sampled stack once, not once per sample in a long block.
          for (const [id, cost] of leaves) {
            const seen = new Set<string>();
            const frames: string[] = [];
            let leaf: string | undefined;
            let app: string | null = null;
            let cursor: number | undefined = id;
            while (cursor !== undefined) {
              const node = nodes.get(cursor);
              if (!node) {
                break;
              }
              const { callFrame: frame, redacted } = sanitizeDiagnosticProfileFrame(
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
                  counts.set(label, (counts.get(label) ?? 0) + cost.samples);
                }
                frames.push(label);
                if (cursor === id) {
                  leaf = label;
                }
                if (app === null && frame.url.startsWith("openclaw:")) {
                  app = label;
                }
              } else if (cursor === id && redacted) {
                leaf = "[redacted]";
                frames.push(leaf);
              }
              cursor = parents.get(cursor);
            }
            if (leaf) {
              const asyncTask =
                app === null && stall.task && stall.task !== "unattributed"
                  ? `[async task:${stall.task.slice(0, 160)}]`
                  : null;
              if (asyncTask) {
                frames.push(asyncTask);
                app = asyncTask;
              }
              const key = JSON.stringify([leaf, app]);
              const total = selfFrames.get(key) ?? { frame: leaf, app, samples: 0, timeUs: 0 };
              total.samples += cost.samples;
              total.timeUs += cost.timeUs;
              selfFrames.set(key, total);
              const tail = frames.slice(0, Math.min(16, app ? frames.indexOf(app) + 1 : 16));
              if (app && tail.at(-1) !== app) {
                tail.push("[...]", app);
              }
              tail.reverse();
              const stackKey = JSON.stringify(tail);
              const stack = stacks.get(stackKey) ?? { frames: tail, samples: 0, timeUs: 0 };
              stack.samples += cost.samples;
              stack.timeUs += cost.timeUs;
              stacks.set(stackKey, stack);
            }
          }
        }
        return formatStallFrames(
          `windowMs=${Math.round(stall.endedAt - stall.startedAt)} windowStartMs=${Math.round(performance.timeOrigin + stall.startedAt)} windowEndMs=${Math.round(performance.timeOrigin + stall.endedAt)} reportedAtMs=${Math.round(performance.timeOrigin + performance.now())} samples=${samples} intervalMs=${SAMPLE_MS} truncated=${truncated}${kernelSummary}`,
          counts,
          selfFrames,
          stacks,
        );
      } catch {
        stop();
        warn("stall flight recorder unavailable: profiler-capture-failed");
        return undefined;
      }
    },
    stop,
  };
}
