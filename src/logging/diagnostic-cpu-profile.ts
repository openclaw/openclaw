import type { Profiler } from "node:inspector";
import { boundedJsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import {
  assertProfile,
  captureDiagnosticProfile,
  DIAGNOSTIC_PROFILE_MAX_BYTES,
  ProfileFailure,
  sanitizeDiagnosticProfileFrame,
} from "./diagnostic-profile.js";

const DURATION_MS = 5_000;
const INTERVAL_MICROS = 10_000;
const MAX_NODES = 16_384;
const MAX_SAMPLES = 65_536;

function sanitizeProfile(
  profile: Profiler.Profile,
  packageRoot: string | null,
  { startBlockedMs }: { startBlockedMs: number },
) {
  assertProfile(
    Array.isArray(profile.nodes) &&
      profile.nodes.length > 0 &&
      Array.isArray(profile.samples) &&
      Array.isArray(profile.timeDeltas) &&
      profile.samples.length === profile.timeDeltas.length &&
      Number.isFinite(profile.startTime) &&
      Number.isFinite(profile.endTime) &&
      profile.endTime >= profile.startTime,
  );
  if (profile.nodes.length > MAX_NODES || profile.samples.length > MAX_SAMPLES) {
    throw new ProfileFailure("profile-too-large");
  }
  const ids = new Set<number>();
  const parents = new Map<number, number>();
  let redactedNodeCount = 0;
  const nodes = profile.nodes.map((node): Profiler.ProfileNode => {
    assertProfile(Number.isSafeInteger(node.id) && node.id > 0 && !ids.has(node.id));
    ids.add(node.id);
    const { callFrame, redacted } = sanitizeDiagnosticProfileFrame(node.callFrame, packageRoot);
    redactedNodeCount += Number(redacted || node.deoptReason !== undefined);
    if (node.children !== undefined) {
      assertProfile(Array.isArray(node.children));
      for (const child of node.children) {
        assertProfile(Number.isSafeInteger(child) && !parents.has(child));
        parents.set(child, node.id);
      }
    }
    assertProfile(
      node.hitCount === undefined || (Number.isSafeInteger(node.hitCount) && node.hitCount >= 0),
    );
    if (node.positionTicks !== undefined) {
      assertProfile(Array.isArray(node.positionTicks));
      for (const tick of node.positionTicks) {
        assertProfile(
          Number.isSafeInteger(tick.line) && Number.isSafeInteger(tick.ticks) && tick.ticks >= 0,
        );
      }
    }
    return {
      id: node.id,
      callFrame,
      ...(node.children !== undefined ? { children: node.children } : {}),
      ...(node.hitCount !== undefined ? { hitCount: node.hitCount } : {}),
      ...(node.positionTicks !== undefined ? { positionTicks: node.positionTicks } : {}),
      ...(node.deoptReason !== undefined ? { deoptReason: "[redacted]" } : {}),
    };
  });
  const roots = nodes.filter((node) => !parents.has(node.id));
  const root = roots[0];
  assertProfile(
    root !== undefined && roots.length === 1 && [...parents.keys()].every((id) => ids.has(id)),
  );
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<number>();
  const pending = [root.id];
  while (pending.length) {
    const id = pending.pop()!;
    assertProfile(!visited.has(id));
    visited.add(id);
    pending.push(...(byId.get(id)!.children ?? []));
  }
  assertProfile(visited.size === nodes.length);
  assertProfile(profile.samples.every((id) => ids.has(id)));
  // V8 deoptimization samples can arrive out of timestamp order; preserve their signed deltas.
  assertProfile(profile.timeDeltas.every((delta) => Number.isFinite(delta)));
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
  if (!boundedJsonUtf8Bytes(result, DIAGNOSTIC_PROFILE_MAX_BYTES).complete) {
    throw new ProfileFailure("profile-too-large");
  }
  return result;
}

/** Captures the main isolate's CPU samples through the shared inspector owner. */
export function captureDiagnosticCpuProfile(options: {
  signal: AbortSignal;
  hasAuthority: () => boolean;
}) {
  return captureDiagnosticProfile({
    ...options,
    durationMs: DURATION_MS,
    setup: async (session) => {
      await session.post("Profiler.enable");
      await session.post("Profiler.setSamplingInterval", { interval: INTERVAL_MICROS });
    },
    start: (session) => session.post("Profiler.start"),
    stop: (session) => session.post("Profiler.stop"),
    disable: (session) => session.post("Profiler.disable"),
    sanitize: sanitizeProfile,
  });
}
