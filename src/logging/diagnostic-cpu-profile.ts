import fs from "node:fs/promises";
import type { Profiler } from "node:inspector";
import type { DiagnosticsCpuProfileParams } from "../../packages/gateway-protocol/src/schema/diagnostics.js";
import { boundedJsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { observeRuntimeProfileCapability } from "../infra/runtime-capabilities.js";
import { reserveDiagnosticProfileFile } from "./diagnostic-profile-file.js";
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
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const WRITE_CHUNK_BYTES = 64 * 1024;

function sanitizeNode(node: Profiler.ProfileNode, packageRoot: string | null) {
  const { callFrame, redacted } = sanitizeDiagnosticProfileFrame(node.callFrame, packageRoot);
  return {
    redacted: redacted || node.deoptReason !== undefined,
    node: {
      id: node.id,
      callFrame,
      ...(node.children !== undefined ? { children: node.children } : {}),
      ...(node.hitCount !== undefined ? { hitCount: node.hitCount } : {}),
      ...(node.positionTicks !== undefined ? { positionTicks: node.positionTicks } : {}),
      ...(node.deoptReason !== undefined ? { deoptReason: "[redacted]" } : {}),
    },
  };
}

function sanitizeCpuProfileResult(
  profile: Profiler.Profile,
  packageRoot: string | null,
  { durationMs, startBlockedMs }: { durationMs: number; startBlockedMs: number },
) {
  assertProfile(profile.samples !== undefined && profile.timeDeltas !== undefined);
  let redactedNodeCount = 0;
  // The runtime owns graph consistency; this boundary bounds and redacts its output.
  const nodes = profile.nodes.map((node): Profiler.ProfileNode => {
    const sanitized = sanitizeNode(node, packageRoot);
    redactedNodeCount += Number(sanitized.redacted);
    return sanitized.node;
  });
  return {
    requestedDurationMs: DURATION_MS,
    actualDurationMs: durationMs,
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
}

export function sanitizeDiagnosticCpuProfile(
  profile: Profiler.Profile,
  packageRoot: string | null,
  measurement: { durationMs: number; startBlockedMs: number },
) {
  assertProfile(profile.samples !== undefined && profile.timeDeltas !== undefined);
  if (profile.nodes.length > MAX_NODES || profile.samples.length > MAX_SAMPLES) {
    throw new ProfileFailure("profile-too-large");
  }
  const result = sanitizeCpuProfileResult(profile, packageRoot, measurement);
  const { nodes } = result.profile;
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
  type SummaryRow = {
    stack: Profiler.ProfileNode["callFrame"][];
    elidedFrameCount: number;
    sampleCount: number;
  };
  const groups = new Map<string, SummaryRow>();
  for (const [id, sampleCount] of counts) {
    const stack: SummaryRow["stack"] = [];
    let node = byId.get(id);
    while (node && stack.length < SUMMARY_STACK_DEPTH) {
      stack.push(node.callFrame);
      node = byId.get(parents.get(node.id)!);
    }
    let elidedFrameCount = 0;
    // Dependency-heavy stacks still need the application caller that owns the work.
    if (!stack.some((frame) => frame.url.startsWith("openclaw:"))) {
      let skipped = 0;
      while (node && !node.callFrame.url.startsWith("openclaw:")) {
        skipped++;
        node = byId.get(parents.get(node.id)!);
      }
      if (node) {
        stack.push(node.callFrame);
        elidedFrameCount = skipped;
      }
    }
    const key = JSON.stringify({ stack, elidedFrameCount });
    const group = groups.get(key);
    if (group) {
      group.sampleCount += sampleCount;
    } else {
      groups.set(key, { stack, elidedFrameCount, sampleCount });
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
export async function captureDiagnosticCpuProfile(
  options: DiagnosticsCpuProfileParams & {
    signal: AbortSignal;
    hasAuthority: () => boolean;
  },
) {
  const batch =
    options.windows !== undefined || options.windowMs !== undefined
      ? { windows: options.windows ?? 1, windowMs: options.windowMs ?? DURATION_MS }
      : undefined;
  const requestedDurationMs = batch ? batch.windows * batch.windowMs : DURATION_MS;
  let artifact: Awaited<ReturnType<typeof reserveDiagnosticProfileFile>> | undefined;
  const assertActive = () => {
    if (options.signal.aborted || !options.hasAuthority()) {
      throw new ProfileFailure("cancelled");
    }
  };
  const reserveFile = async () => {
    try {
      return (artifact = await reserveDiagnosticProfileFile("cpu", assertActive, MAX_FILE_BYTES));
    } catch (error) {
      throw error instanceof ProfileFailure ? error : new ProfileFailure("capture-failed");
    }
  };
  const outcome = await observeRuntimeProfileCapability(
    "cpuProfiling",
    captureDiagnosticProfile({
      ...options,
      durationMs: requestedDurationMs,
      create: (inspector) => {
        // Node 24's native API ignores the sampling interval, overflowing long batches.
        const capture =
          process.versions.bun || (batch && Number(process.versions.node.split(".")[0]) < 26)
            ? createInspectorProfileCapture(inspector, {
                setup: async (session) => {
                  await session.post("Profiler.enable");
                  await session.post("Profiler.setSamplingInterval", { interval: INTERVAL_MICROS });
                },
                start: (session) => session.post("Profiler.start"),
                stop: (session) => session.post("Profiler.stop"),
                disable: (session) => session.post("Profiler.disable"),
              })
            : createNativeCpuProfileCapture(INTERVAL_MICROS);
        return {
          ...capture,
          setup: async () => {
            // RPC duration bounds are admitted before this owner. Check the known
            // file budget and writable destination before paying V8's startup scan.
            if (batch) {
              await reserveFile();
            }
            await capture.setup?.();
          },
        };
      },
      sanitize: async (profile, packageRoot, measurement) => {
        assertProfile(profile.samples !== undefined && profile.timeDeltas !== undefined);
        if (!batch && profile.nodes.length <= MAX_NODES && profile.samples.length <= MAX_SAMPLES) {
          const inline = sanitizeCpuProfileResult(profile, packageRoot, measurement);
          if (boundedJsonUtf8Bytes(inline, DIAGNOSTIC_PROFILE_MAX_BYTES).complete) {
            return inline;
          }
        }
        const file = artifact ?? (await reserveFile());
        let redactedNodeCount = 0;
        function* parts() {
          yield `{"startTime":${profile.startTime},"endTime":${profile.endTime},"nodes":[`;
          for (const [index, node] of profile.nodes.entries()) {
            const sanitized = sanitizeNode(node, packageRoot);
            redactedNodeCount += Number(sanitized.redacted);
            yield `${index ? "," : ""}${JSON.stringify(sanitized.node)}`;
          }
          yield "]";
          for (const field of ["samples", "timeDeltas"] as const) {
            yield `,"${field}":[`;
            const values = profile[field]!;
            for (let index = 0; index < values.length; index += 4096) {
              yield `${index ? "," : ""}${JSON.stringify(values.slice(index, index + 4096)).slice(1, -1)}`;
            }
            yield "]";
          }
          yield "}";
        }
        let sizeBytes = 0;
        let chunk = "";
        let chunkBytes = 0;
        const flush = async () => {
          assertActive();
          await file.handle.writeFile(chunk, "utf8").catch(() => {
            throw new ProfileFailure("capture-failed");
          });
          chunk = "";
          chunkBytes = 0;
        };
        // Bound encoding work between asynchronous writes instead of stringifying
        // a large graph in one main-thread turn. The artifact keeps the full timeline.
        for (const part of parts()) {
          const bytes = Buffer.byteLength(part);
          sizeBytes += bytes;
          if (sizeBytes > MAX_FILE_BYTES) {
            throw new ProfileFailure("profile-too-large");
          }
          chunk += part;
          chunkBytes += bytes;
          if (chunkBytes >= WRITE_CHUNK_BYTES) {
            await flush();
          }
        }
        if (chunk) {
          await flush();
        }
        return {
          path: file.path,
          sizeBytes,
          requestedDurationMs,
          actualDurationMs: measurement.durationMs,
          startBlockedMs: measurement.startBlockedMs,
          samplingIntervalMicros: INTERVAL_MICROS,
          sampleLossCount: null,
          redactedNodeCount,
          windowBoundariesMicros: [
            ...Array.from(
              { length: batch?.windows ?? 1 },
              (_, index) => profile.startTime + index * (batch?.windowMs ?? DURATION_MS) * 1_000,
            ),
            profile.endTime,
          ],
          summary: { nodeCount: profile.nodes.length, sampleCount: profile.samples.length },
        };
      },
    }),
  );
  const closeFailed = artifact
    ? await artifact.handle.close().then(
        () => false,
        () => true,
      )
    : false;
  if (artifact && (outcome.status === "unavailable" || closeFailed)) {
    const removalFailed = await fs.unlink(artifact.path).then(
      () => false,
      () => true,
    );
    if (outcome.status === "unavailable") {
      outcome.cleanupFailed ||= closeFailed || removalFailed;
    } else {
      return {
        status: "unavailable" as const,
        reason: "cleanup-failed" as const,
        cleanupFailed: true,
      };
    }
  }
  return outcome;
}
