import type { Profiler } from "node:inspector";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { boundedJsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { parseNodeOptionsEnvVar } from "../infra/node-options.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";

const DURATION_MS = 5_000;
const INTERVAL_MICROS = 10_000;
const MAX_BYTES = 1024 * 1024;
const MAX_NODES = 16_384;
const MAX_SAMPLES = 65_536;
const ENGINE_NAMES = new Set(["(root)", "(program)", "(idle)", "(garbage collector)"]);
let capturing = false;
let cleanupUncertain = false;

type FailureReason =
  | "busy"
  | "unsupported"
  | "conflict"
  | "tracing-active"
  | "cancelled"
  | "invalid-profile"
  | "profile-too-large"
  | "capture-failed"
  | "cleanup-failed";

export type DiagnosticCpuProfileOutcome =
  | {
      status: "complete";
      result: {
        requestedDurationMs: number;
        actualDurationMs: number;
        samplingIntervalMicros: number;
        sampleLossCount: null;
        redactedNodeCount: number;
        profile: Profiler.Profile;
      };
    }
  | { status: "unavailable"; reason: FailureReason; cleanupFailed: boolean };

class ProfileFailure extends Error {
  constructor(readonly reason: FailureReason) {
    super(reason);
  }
}

function assertProfile(valid: boolean): asserts valid {
  if (!valid) {
    throw new ProfileFailure("invalid-profile");
  }
}

function hasProfilerConflict() {
  const options = parseNodeOptionsEnvVar(process.env.NODE_OPTIONS);
  return (
    options === null ||
    Boolean(process.env.NODE_V8_COVERAGE) ||
    [...process.execArgv, ...(options ?? [])].some((option) =>
      /^--(?:inspect|cpu-prof|heap-prof|prof|perf-|.*coverage)/.test(option.replaceAll("_", "-")),
    )
  );
}

function codeUrl(url: string, packageRoot: string | null): string | undefined {
  if (/^node:[a-zA-Z0-9_./-]+$/.test(url)) {
    return url;
  }
  if (!packageRoot || url.length > 2_048) {
    return undefined;
  }
  let filename = url;
  if (url.startsWith("file:")) {
    try {
      const parsed = new URL(url);
      if (parsed.search || parsed.hash) {
        return undefined;
      }
      filename = fileURLToPath(parsed);
    } catch {
      return undefined;
    }
  }
  if (!path.isAbsolute(filename)) {
    return undefined;
  }
  const relative = path.relative(packageRoot, filename).split(path.sep).join("/");
  return /^(?:src|dist|node_modules)\/[a-zA-Z0-9_@./+-]+\.[cm]?js$/.test(relative) ||
    /^src\/[a-zA-Z0-9_@./+-]+\.ts$/.test(relative)
    ? `openclaw:${relative}`
    : undefined;
}

function sanitizeProfile(profile: Profiler.Profile, packageRoot: string | null) {
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
    const frame = node.callFrame;
    assertProfile(
      Boolean(frame) &&
        typeof frame.functionName === "string" &&
        typeof frame.url === "string" &&
        typeof frame.scriptId === "string" &&
        /^\d{1,32}$/.test(frame.scriptId) &&
        Number.isSafeInteger(frame.lineNumber) &&
        frame.lineNumber >= -1 &&
        Number.isSafeInteger(frame.columnNumber) &&
        frame.columnNumber >= -1,
    );
    const url = codeUrl(frame.url, packageRoot);
    const engine = frame.url === "" && ENGINE_NAMES.has(frame.functionName);
    const safeName =
      engine ||
      (url !== undefined &&
        frame.functionName.length <= 256 &&
        /^(?:(?:(?:get|set) )?[$A-Z_a-z][$\w]*(?:\.[$A-Z_a-z][$\w]*)*)?$/.test(frame.functionName));
    const redacted = !safeName || (!engine && !url) || node.deoptReason !== undefined;
    redactedNodeCount += Number(redacted);
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
          Number.isSafeInteger(tick.line) &&
            tick.line >= 0 &&
            Number.isSafeInteger(tick.ticks) &&
            tick.ticks >= 0,
        );
      }
    }
    return {
      id: node.id,
      callFrame: {
        functionName: safeName ? frame.functionName : "[redacted]",
        scriptId: frame.scriptId,
        url: url ?? "",
        lineNumber: frame.lineNumber,
        columnNumber: frame.columnNumber,
      },
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
  assertProfile(profile.timeDeltas.every((delta) => Number.isFinite(delta) && delta >= 0));
  const result = {
    requestedDurationMs: DURATION_MS,
    actualDurationMs: (profile.endTime - profile.startTime) / 1_000,
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
  if (!boundedJsonUtf8Bytes(result, MAX_BYTES).complete) {
    throw new ProfileFailure("profile-too-large");
  }
  return result;
}

/** Owns one ephemeral main-isolate capture; it never opens an inspector listener. */
export async function captureDiagnosticCpuProfile(options: {
  signal: AbortSignal;
  hasAuthority: () => boolean;
}): Promise<DiagnosticCpuProfileOutcome> {
  const unavailable = (
    reason: FailureReason,
    cleanupFailed = false,
  ): DiagnosticCpuProfileOutcome => ({
    status: "unavailable",
    reason,
    cleanupFailed,
  });
  if (cleanupUncertain) {
    return unavailable("cleanup-failed", true);
  }
  if (capturing) {
    return unavailable("busy");
  }
  capturing = true;
  let session: import("node:inspector/promises").Session | undefined;
  let connected = false;
  let startAttempted = false;
  let stopAttempted = false;
  let failure: FailureReason | undefined;
  let cleanupFailed = false;
  let profile: Profiler.Profile | undefined;
  let packageRoot: string | null = null;
  const assertActive = () => {
    if (options.signal.aborted || !options.hasAuthority()) {
      throw new ProfileFailure("cancelled");
    }
  };
  try {
    assertActive();
    if (process.versions.bun) {
      throw new ProfileFailure("unsupported");
    }
    const inspector = await import("node:inspector/promises").catch(() => {
      throw new ProfileFailure("unsupported");
    });
    const { getEnabledCategories } = await import("node:trace_events").catch(() => {
      throw new ProfileFailure("unsupported");
    });
    const assertTracingInactive = () => {
      // V8 can stream raw ProfileChunk data to an existing trace writer before
      // sanitization. Refuse all tracing; legacy and Perfetto match categories differently.
      if (getEnabledCategories()) {
        throw new ProfileFailure("tracing-active");
      }
    };
    packageRoot = await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url });
    assertActive();
    // Disconnect also disables precise coverage in V8. Do not disturb a known
    // debugger/coverage owner; arbitrary third-party in-process sessions are not discoverable.
    if (inspector.url() || hasProfilerConflict()) {
      throw new ProfileFailure("conflict");
    }
    assertTracingInactive();
    session = new inspector.Session();
    session.connect();
    connected = true;
    await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", { interval: INTERVAL_MICROS });
    assertActive();
    assertTracingInactive();
    startAttempted = true;
    await session.post("Profiler.start");
    // The event loop owns this timer. Requested duration is not a hard wall-time
    // or V8 allocation bound when the Gateway is blocked; return native actual timing.
    await delay(DURATION_MS, undefined, { signal: options.signal });
    assertActive();
    stopAttempted = true;
    ({ profile } = await session.post("Profiler.stop"));
  } catch (error) {
    failure =
      error instanceof ProfileFailure
        ? error.reason
        : options.signal.aborted
          ? "cancelled"
          : "capture-failed";
  } finally {
    if (session && connected) {
      if (startAttempted && !stopAttempted) {
        try {
          await session.post("Profiler.stop");
        } catch {
          cleanupFailed = true;
        }
      }
      try {
        await session.post("Profiler.disable");
      } catch {
        cleanupFailed = true;
      }
      try {
        session.disconnect();
      } catch {
        cleanupFailed = cleanupUncertain = true;
      }
    }
    capturing = false;
  }
  if (failure || cleanupFailed) {
    return unavailable(failure ?? "cleanup-failed", cleanupFailed);
  }
  try {
    assertActive();
    return { status: "complete", result: sanitizeProfile(profile!, packageRoot) };
  } catch (error) {
    return unavailable(error instanceof ProfileFailure ? error.reason : "invalid-profile");
  }
}
