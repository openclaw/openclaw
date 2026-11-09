import type { Runtime } from "node:inspector";
import { performance } from "node:perf_hooks";
import { parseNativeCpuProfile, sanitizeDiagnosticProfileFrame } from "./diagnostic-profile.js";

export const SAMPLE_MS = 25;
export const MAX_SAMPLES = 1_024;
export const MAX_PROFILE_BYTES = 1_048_576;
const MAX_REPORT_BYTES = 2_048;
export type StallProfileWindow = { json: string | undefined; endedAt: number };
export type StallStackSample = { at: number; frames: Runtime.CallFrame[] };
export type StallProfileSnapshot = {
  windows: StallProfileWindow[];
  stacks?: StallStackSample[];
  endedAt: number;
  captureMs: number;
};
type StallProfileInterval = { startedAt: number; endedAt: number; task?: string };

type SelfFrame = { frame: string; app: string | null; samples: number; timeUs: number | null };
type SampledStack = { frames: string[]; samples: number; timeUs: number | null };

function formatStallFrames(
  header: string,
  counts: Map<string, number>,
  selfFrames: Map<string, SelfFrame>,
  stacks: Map<string, SampledStack>,
) {
  const inclusive = [...counts].toSorted((a, b) => b[1] - a[1]).slice(0, 8);
  const self = [...selfFrames.values()]
    .toSorted((a, b) => (b.timeUs ?? 0) - (a.timeUs ?? 0) || b.samples - a.samples)
    .slice(0, 10)
    .map(({ frame, samples, timeUs, app }) => [
      frame,
      samples,
      timeUs === null ? null : Math.round(timeUs / 100) / 10,
      app,
    ]);
  const deepest: Array<[number, string[]]> = [...stacks.values()]
    .toSorted((a, b) => (b.timeUs ?? 0) - (a.timeUs ?? 0) || b.samples - a.samples)
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

export function formatStallProfile(
  windows: StallProfileWindow[],
  stall: StallProfileInterval,
  packageRoot: string | null,
  kernelSummary = "",
  interruptSamples: StallStackSample[] = [],
) {
  const counts = new Map<string, number>();
  const selfFrames = new Map<string, SelfFrame>();
  const stacks = new Map<string, SampledStack>();
  let samples = 0;
  let truncated = windows.length === 0;
  const recordStack = (
    callFrames: Iterable<Runtime.CallFrame>,
    cost: { samples: number; timeUs: number | null },
  ) => {
    const seen = new Set<string>();
    const frames: string[] = [];
    let leaf: string | undefined;
    let app: string | null = null;
    let first = true;
    for (const rawFrame of callFrames) {
      const { callFrame: frame, redacted } = sanitizeDiagnosticProfileFrame(rawFrame, packageRoot);
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
        if (first) {
          leaf = label;
        }
        if (app === null && frame.url.startsWith("openclaw:")) {
          app = label;
        }
      } else if (first && redacted) {
        leaf = "[redacted]";
        frames.push(leaf);
      }
      first = false;
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
      total.timeUs = cost.timeUs === null ? null : (total.timeUs ?? 0) + cost.timeUs;
      selfFrames.set(key, total);
      const tail = frames.slice(0, Math.min(16, app ? frames.indexOf(app) + 1 : 16));
      if (app && tail.at(-1) !== app) {
        tail.push("[...]", app);
      }
      tail.reverse();
      const stackKey = JSON.stringify(tail);
      const stack = stacks.get(stackKey) ?? { frames: tail, samples: 0, timeUs: 0 };
      stack.samples += cost.samples;
      stack.timeUs = cost.timeUs === null ? null : (stack.timeUs ?? 0) + cost.timeUs;
      stacks.set(stackKey, stack);
    }
  };
  for (const window of windows) {
    if (window.json === undefined) {
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
      function* callFrames() {
        let cursor: number | undefined = id;
        while (cursor !== undefined) {
          const node = nodes.get(cursor);
          if (!node) break;
          yield node.callFrame;
          cursor = parents.get(cursor);
        }
      }
      recordStack(callFrames(), cost);
    }
  }
  for (const sample of interruptSamples) {
    if (sample.at >= stall.startedAt && sample.at <= stall.endedAt) {
      samples++;
      recordStack(sample.frames, { samples: 1, timeUs: null });
    }
  }
  const cpu = interruptSamples.length
    ? `samples=${samples} sampleMode=interrupt`
    : windows.length
      ? `samples=${samples} intervalMs=${SAMPLE_MS}`
      : "cpuProfile=unavailable";
  return formatStallFrames(
    `windowMs=${Math.round(stall.endedAt - stall.startedAt)} windowStartMs=${Math.round(performance.timeOrigin + stall.startedAt)} windowEndMs=${Math.round(performance.timeOrigin + stall.endedAt)} reportedAtMs=${Math.round(performance.timeOrigin + performance.now())} ${cpu} truncated=${truncated}${kernelSummary}`,
    counts,
    selfFrames,
    stacks,
  );
}
