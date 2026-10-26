import type { Profiler, Runtime } from "node:inspector";
import type { Session } from "node:inspector/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { HeapSpaceInfo } from "node:v8";
import * as v8 from "node:v8";
import { isMainThread } from "node:worker_threads";
import { parseNodeOptionsEnvVar } from "../../node-runtime-env.mjs";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";

export const DIAGNOSTIC_PROFILE_MAX_BYTES = 1024 * 1024;
const ENGINE_NAMES = new Set([
  "(root)",
  "(program)",
  "(idle)",
  "(garbage collector)",
  // V8's heap sampler names its VM state when no JavaScript frame is available.
  "(GC)",
  "(PARSER)",
  "(COMPILER)",
  "(BYTECODE_COMPILER)",
  "(V8 API)",
  "(EXTERNAL)",
  "(LOGGING)",
  "(IDLE_EXTERNAL)",
  "(IDLE)",
  "(JS)",
  "(deopt)",
]);
let capturing = false;

type FailureReason =
  | "cooldown"
  | "heap-too-large"
  | "busy"
  | "unsupported"
  | "conflict"
  | "tracing-active"
  | "cancelled"
  | "invalid-profile"
  | "profile-too-large"
  | "capture-failed"
  | "cleanup-failed";

export type DiagnosticProfileOutcome<Result> =
  | { status: "complete"; result: Result }
  | { status: "unavailable"; reason: FailureReason; cleanupFailed: boolean };

type ProfileMemoryUsage = NodeJS.MemoryUsage & { heapSpaces: HeapSpaceInfo[] };
export class ProfileFailure extends Error {
  constructor(readonly reason: FailureReason) {
    super(reason);
  }
}

export function assertProfile(valid: boolean): asserts valid {
  if (!valid) {
    throw new ProfileFailure("invalid-profile");
  }
}

export function parseNativeCpuProfile(json: string): Profiler.Profile {
  // V8 writes names and URLs verbatim. Escape them before decoding its native format.
  const escaped = json.replace(
    /"functionName":"(.*?)"(,"lineNumber":-?\d+,"columnNumber":-?\d+,"scriptId":-?\d+,"url":)"(.*?)"}(?=,"(?:children|deoptReason|positionTicks)":|})/gs,
    (_match, name: string, location: string, url: string) =>
      `"functionName":${JSON.stringify(name)}${location}${JSON.stringify(url)}}`,
  );
  // SAFETY: Only V8's native serializer supplies this graph and numeric script IDs.
  const profile = JSON.parse(escaped) as Omit<Profiler.Profile, "nodes"> & {
    nodes: (Omit<Profiler.ProfileNode, "callFrame"> & {
      callFrame: Omit<Runtime.CallFrame, "scriptId"> & { scriptId: number };
    })[];
  };
  // The native serializer owns this shape; inspector consumers require string IDs.
  const nodes: Profiler.ProfileNode[] = [];
  for (const node of profile.nodes) {
    const frame = node.callFrame;
    nodes.push({ ...node, callFrame: { ...frame, scriptId: String(frame.scriptId) } });
  }
  return { ...profile, nodes };
}

type ProfileCapture<Profile> = {
  setup?: () => Promise<unknown>;
  start: () => unknown;
  stop: () => Promise<{ profile: Profile }> | { profile: Profile } | undefined;
  close: () => unknown;
};

export function createInspectorProfileCapture<Profile>(
  inspector: typeof import("node:inspector/promises"),
  options: {
    setup: (session: Session) => Promise<unknown>;
    start: (session: Session) => Promise<unknown>;
    stop: (session: Session) => Promise<{ profile: Profile }>;
    disable: (session: Session) => Promise<unknown>;
  },
): ProfileCapture<Profile> {
  const session = new inspector.Session();
  session.connect();
  return {
    setup: () => options.setup(session),
    start: () => options.start(session),
    stop: () => options.stop(session),
    close: async () => {
      let disabled = false;
      try {
        await options.disable(session);
        disabled = true;
      } catch {
        // Disconnect must still release the inspector after a failed disable.
      }
      session.disconnect();
      if (!disabled) {
        throw new ProfileFailure("cleanup-failed");
      }
    },
  };
}

export function createNativeCpuProfileCapture(
  intervalMicros: number,
): ProfileCapture<Profiler.Profile> {
  let handle: v8.SyncCPUProfileHandle | undefined;
  return {
    // Node shares its native profiler with the stall recorder's overlapping windows.
    start: () => (handle = v8.startCpuProfile({ sampleInterval: intervalMicros / 1_000 })),
    stop: () => handle && { profile: parseNativeCpuProfile(handle.stop()) },
    close: () => handle?.[Symbol.dispose](),
  };
}

export function hasProfilerConflict() {
  const options = parseNodeOptionsEnvVar(process.env.NODE_OPTIONS);
  return (
    options === null ||
    Boolean(process.env.NODE_V8_COVERAGE) ||
    // Bun's environment-started inspector is not reported by inspector.url().
    Boolean(
      process.versions.bun && (process.env.BUN_INSPECT || process.env.BUN_INSPECT_CONNECT_TO),
    ) ||
    [...process.execArgv, ...(options ?? [])].some((option) =>
      /^--(?:inspect|cpu-prof|heap-prof|prof|perf-|.*coverage)/.test(option.replaceAll("_", "-")),
    )
  );
}

function codeUrl(url: string, packageRoot: string | null): string | undefined {
  if (/^node:[a-zA-Z0-9_./-]+$/.test(url)) {
    return url;
  }
  // Path normalization can erase suffix segments containing parent traversals.
  if (url.length > 2_048 || /[?#]/.test(url)) {
    return undefined;
  }
  let filename = url;
  if (url.startsWith("file:")) {
    try {
      filename = fileURLToPath(url);
    } catch {
      return undefined;
    }
  }
  if (!path.isAbsolute(filename)) {
    return undefined;
  }
  const relative = packageRoot
    ? path.relative(packageRoot, filename).split(path.sep).join("/")
    : "";
  // Ignore the installation's enclosing node_modules; classify only its contents.
  const dependency = (
    packageRoot && !relative.startsWith("..")
      ? `/${relative}`
      : path.normalize(filename).split(path.sep).join("/")
  ).match(
    /.*\/node_modules\/((?:@[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9_-][a-zA-Z0-9._-]*)\//,
  )?.[1];
  if (dependency) {
    return `node_modules/${dependency}`;
  }
  return /^(?:src|dist)\/[a-zA-Z0-9_@./+-]+\.[cm]?js$/.test(relative) ||
    /^src\/[a-zA-Z0-9_@./+-]+\.ts$/.test(relative)
    ? `openclaw:${relative}`
    : undefined;
}

/** Applies the same code-location and symbol policy to both native profilers. */
export function sanitizeDiagnosticProfileFrame(
  frame: Runtime.CallFrame,
  packageRoot: string | null,
) {
  // V8 emits signed source offsets and negative script IDs for WebAssembly wrappers.
  assertProfile(
    Boolean(frame) &&
      typeof frame.functionName === "string" &&
      typeof frame.url === "string" &&
      typeof frame.scriptId === "string" &&
      /^-?\d{1,32}$/.test(frame.scriptId) &&
      Number.isSafeInteger(frame.lineNumber) &&
      Number.isSafeInteger(frame.columnNumber),
  );
  const url = codeUrl(frame.url, packageRoot);
  const engine = frame.url === "" && ENGINE_NAMES.has(frame.functionName);
  const attribution = url?.startsWith("node_modules/")
    ? `[dep:${url.slice(13)}]`
    : frame.scriptId === "0" && frame.url === "" && frame.lineNumber < 0 && !engine
      ? "[native]"
      : undefined;
  const safeName =
    engine ||
    (url !== undefined &&
      frame.functionName.length <= 256 &&
      /^(?:(?:(?:get|set) )?[$A-Z_a-z][$\w]*(?:\.[$A-Z_a-z][$\w]*)*)?$/.test(frame.functionName));
  return {
    redacted: !safeName && !attribution,
    callFrame: {
      functionName: attribution ?? (safeName ? frame.functionName : "[redacted]"),
      scriptId: frame.scriptId,
      url: url ?? "",
      lineNumber: frame.lineNumber,
      columnNumber: frame.columnNumber,
    },
  };
}

/** Owns one ephemeral isolate-local capture; it never opens an inspector listener. */
export async function captureDiagnosticProfile<Profile, Result>(options: {
  signal?: AbortSignal;
  hasAuthority: () => boolean;
  durationMs: number;
  /** Worker captures require tracing admission from the Gateway; trace_events is main-only. */
  workerTracingInactive?: true;
  create: (inspector: typeof import("node:inspector/promises")) => ProfileCapture<Profile>;
  sanitize: (
    profile: Profile,
    packageRoot: string | null,
    measurement: {
      durationMs: number;
      startBlockedMs: number;
      before: ProfileMemoryUsage;
      after: ProfileMemoryUsage;
    },
  ) => Result | Promise<Result>;
}): Promise<DiagnosticProfileOutcome<Result>> {
  const unavailable = (
    reason: FailureReason,
    cleanupFailed = false,
  ): DiagnosticProfileOutcome<Result> => ({
    status: "unavailable",
    reason,
    cleanupFailed,
  });
  if (capturing) {
    return unavailable("busy");
  }
  capturing = true;
  let capture: ProfileCapture<Profile> | undefined;
  let startAttempted = false;
  let stopAttempted = false;
  let failure: FailureReason | undefined;
  let cleanupFailed = false;
  let profile: Profile | undefined;
  let before: ProfileMemoryUsage | undefined;
  let after: ProfileMemoryUsage | undefined;
  let durationMs = 0;
  let startBlockedMs = 0;
  let packageRoot: string | null = null;
  const assertActive = () => {
    if (options.signal?.aborted || !options.hasAuthority()) {
      throw new ProfileFailure("cancelled");
    }
  };
  try {
    assertActive();
    const inspector = await import("node:inspector/promises").catch(() => {
      throw new ProfileFailure("unsupported");
    });
    const getEnabledCategories =
      !isMainThread && options.workerTracingInactive
        ? () => undefined
        : (
            await import("node:trace_events").catch(() => {
              throw new ProfileFailure("unsupported");
            })
          ).getEnabledCategories;
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
    capture = options.create(inspector);
    await capture.setup?.();
    assertActive();
    assertTracingInactive();
    before = { ...process.memoryUsage(), heapSpaces: v8.getHeapSpaceStatistics() };
    const startedAt = performance.now();
    startAttempted = true;
    // Inspector dispatch can synchronously scan V8's heap before returning a promise.
    const starting = capture.start();
    startBlockedMs = performance.now() - startedAt;
    await starting;
    // The event loop owns this timer. Requested duration is not a hard wall-time
    // or V8 allocation bound when the Gateway is blocked; return native actual timing.
    if (options.durationMs > 0) {
      await delay(options.durationMs, undefined, { signal: options.signal });
    }
    assertActive();
    stopAttempted = true;
    const stopped = await capture.stop();
    if (!stopped) {
      throw new ProfileFailure("capture-failed");
    }
    ({ profile } = stopped);
    durationMs = performance.now() - startedAt;
    after = { ...process.memoryUsage(), heapSpaces: v8.getHeapSpaceStatistics() };
  } catch (error) {
    failure =
      error instanceof ProfileFailure
        ? error.reason
        : options.signal?.aborted
          ? "cancelled"
          : error instanceof Error && error.message.startsWith("Inspector error -32601:")
            ? "unsupported"
            : "capture-failed";
  } finally {
    if (capture) {
      if (startAttempted && !stopAttempted) {
        try {
          await capture.stop();
        } catch {
          cleanupFailed = true;
        }
      }
      try {
        await capture.close();
      } catch {
        cleanupFailed = true;
      }
    }
  }
  if (failure || cleanupFailed) {
    capturing = false;
    return unavailable(failure ?? "cleanup-failed", cleanupFailed);
  }
  try {
    assertActive();
    const result = await options.sanitize(profile!, packageRoot, {
      durationMs,
      startBlockedMs,
      before: before!,
      after: after!,
    });
    assertActive();
    return { status: "complete", result };
  } catch (error) {
    return unavailable(error instanceof ProfileFailure ? error.reason : "invalid-profile");
  } finally {
    capturing = false;
  }
}
