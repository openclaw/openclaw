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

function sanitizeProfile(
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
  if (!boundedJsonUtf8Bytes(result, DIAGNOSTIC_PROFILE_MAX_BYTES).complete) {
    throw new ProfileFailure("profile-too-large");
  }
  return result;
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
    sanitize: sanitizeProfile,
  });
}
