import type { Profiler } from "node:inspector";
import { boundedJsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import {
  assertProfile,
  captureDiagnosticProfile,
  createInspectorProfileCapture,
  createNativeCpuProfileCapture,
  DIAGNOSTIC_PROFILE_MAX_BYTES,
  ProfileFailure,
  sanitizeDiagnosticProfileFrame,
} from "./diagnostic-profile.js";

const DURATION_MS = 5_000;
const INTERVAL_MICROS = 10_000;
const MAX_NODES = 16_384;
const MAX_SAMPLES = 65_536;
const SUMMARY_STACK_DEPTH = 8;
const MAX_SUMMARY_ROWS = 128;

export function sanitizeDiagnosticCpuProfile(
  profile: Profiler.Profile,
  packageRoot: string | null,
  { startBlockedMs }: { startBlockedMs: number },
) {
  assertProfile(profile.samples !== undefined && profile.timeDeltas !== undefined);
  if (profile.nodes.length > MAX_NODES || profile.samples.length > MAX_SAMPLES) {
    throw new ProfileFailure("profile-too-large");
  }
  let redactedNodeCount = 0;
  // The runtime owns graph consistency; this boundary bounds and redacts its output.
  const nodes = profile.nodes.map((node): Profiler.ProfileNode => {
    const { callFrame, redacted } = sanitizeDiagnosticProfileFrame(node.callFrame, packageRoot);
    redactedNodeCount += Number(redacted || node.deoptReason !== undefined);
    return {
      id: node.id,
      callFrame,
      ...(node.children !== undefined ? { children: node.children } : {}),
      ...(node.hitCount !== undefined ? { hitCount: node.hitCount } : {}),
      ...(node.positionTicks !== undefined ? { positionTicks: node.positionTicks } : {}),
      ...(node.deoptReason !== undefined ? { deoptReason: "[redacted]" } : {}),
    };
  });
  const result = {
    requestedDurationMs: DURATION_MS,
    actualDurationMs: (profile.endTime - profile.startTime) / 1_000,
    startBlockedMs,
    samplingIntervalMicros: INTERVAL_MICROS,
    sampleLossCount: null,
    redactedNodeCount,
    profile: {
      nodes,
      startTime: profile.startTime,
      endTime: profile.endTime,
      samples: profile.samples,
      timeDeltas: profile.timeDeltas,
    },
  };
  if (boundedJsonUtf8Bytes(result, DIAGNOSTIC_PROFILE_MAX_BYTES).complete) {
    return result;
  }

  // Boot/deoptimization can produce deep stacks even at a coarse sampling interval.
  // Count recorded samples, not hitCount: V8's deopt samples can have zero hits.
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of nodes) {
    for (const child of node.children ?? []) {
      parents.set(child, node.id);
    }
  }
  const counts = new Map<number, number>();
  for (const id of profile.samples) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  type SummaryRow = { stack: Profiler.ProfileNode["callFrame"][]; sampleCount: number };
  const groups = new Map<string, SummaryRow>();
  for (const [id, sampleCount] of counts) {
    const stack: SummaryRow["stack"] = [];
    let node = byId.get(id);
    while (node && stack.length < SUMMARY_STACK_DEPTH) {
      stack.push(node.callFrame);
      node = byId.get(parents.get(node.id)!);
    }
    const key = JSON.stringify(stack);
    const group = groups.get(key);
    if (group) {
      group.sampleCount += sampleCount;
    } else {
      groups.set(key, { stack, sampleCount });
    }
  }
  const summaryRows: SummaryRow[] = [];
  const summary = {
    ...result,
    profile: undefined,
    truncated: true,
    originalNodeCount: nodes.length,
    sampleCount: profile.samples.length,
    omittedSampleCount: profile.samples.length,
    summary: summaryRows,
  };
  let bytes = Buffer.byteLength(JSON.stringify(summary));
  for (const row of [...groups.values()].toSorted((a, b) => b.sampleCount - a.sampleCount)) {
    const extra = Buffer.byteLength(JSON.stringify(row)) + Number(summary.summary.length > 0);
    if (
      summary.summary.length === MAX_SUMMARY_ROWS ||
      bytes + extra > DIAGNOSTIC_PROFILE_MAX_BYTES
    ) {
      break;
    }
    summary.summary.push(row);
    summary.omittedSampleCount -= row.sampleCount;
    bytes += extra;
  }
  return summary;
}

/** Captures CPU samples through Node's shared native profiler or Bun's inspector. */
export function captureDiagnosticCpuProfile(options: {
  signal: AbortSignal;
  hasAuthority: () => boolean;
}) {
  return captureDiagnosticProfile({
    ...options,
    durationMs: DURATION_MS,
    create: (inspector) =>
      process.versions.bun
        ? createInspectorProfileCapture(inspector, {
            setup: async (session) => {
              await session.post("Profiler.enable");
              await session.post("Profiler.setSamplingInterval", { interval: INTERVAL_MICROS });
            },
            start: (session) => session.post("Profiler.start"),
            stop: (session) => session.post("Profiler.stop"),
            disable: (session) => session.post("Profiler.disable"),
          })
        : createNativeCpuProfileCapture(INTERVAL_MICROS),
    sanitize: sanitizeDiagnosticCpuProfile,
  });
}
