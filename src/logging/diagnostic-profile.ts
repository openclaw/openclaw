import type { Runtime } from "node:inspector";
import type { Session } from "node:inspector/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseNodeOptionsEnvVar } from "../infra/node-options.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";

export const DIAGNOSTIC_PROFILE_MAX_BYTES = 1024 * 1024;
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

export type DiagnosticProfileOutcome<Result> =
  | { status: "complete"; result: Result }
  | { status: "unavailable"; reason: FailureReason; cleanupFailed: boolean };

type ProfileMeasurement = {
  durationMs: number;
  before: NodeJS.MemoryUsage;
  after: NodeJS.MemoryUsage;
};

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
  const safeName =
    engine ||
    (url !== undefined &&
      frame.functionName.length <= 256 &&
      /^(?:(?:(?:get|set) )?[$A-Z_a-z][$\w]*(?:\.[$A-Z_a-z][$\w]*)*)?$/.test(frame.functionName));
  const redacted = !safeName || (!engine && !url);
  return {
    redacted,
    callFrame: {
      functionName: safeName ? frame.functionName : "[redacted]",
      scriptId: frame.scriptId,
      url: url ?? "",
      lineNumber: frame.lineNumber,
      columnNumber: frame.columnNumber,
    },
  };
}

/** Owns one ephemeral main-isolate capture; it never opens an inspector listener. */
export async function captureDiagnosticProfile<Profile, Result>(options: {
  signal: AbortSignal;
  hasAuthority: () => boolean;
  durationMs: number;
  setup: (session: Session) => Promise<unknown>;
  start: (session: Session) => Promise<unknown>;
  stop: (session: Session) => Promise<{ profile: Profile }>;
  disable: (session: Session) => Promise<unknown>;
  sanitize: (
    profile: Profile,
    packageRoot: string | null,
    measurement: ProfileMeasurement,
  ) => Result;
}): Promise<DiagnosticProfileOutcome<Result>> {
  const unavailable = (
    reason: FailureReason,
    cleanupFailed = false,
  ): DiagnosticProfileOutcome<Result> => ({
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
  let profile: Profile | undefined;
  let before: NodeJS.MemoryUsage | undefined;
  let after: NodeJS.MemoryUsage | undefined;
  let durationMs = 0;
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
    await options.setup(session);
    assertActive();
    assertTracingInactive();
    before = process.memoryUsage();
    const startedAt = performance.now();
    startAttempted = true;
    await options.start(session);
    // The event loop owns this timer. Requested duration is not a hard wall-time
    // or V8 allocation bound when the Gateway is blocked; return native actual timing.
    await delay(options.durationMs, undefined, { signal: options.signal });
    assertActive();
    stopAttempted = true;
    ({ profile } = await options.stop(session));
    durationMs = performance.now() - startedAt;
    after = process.memoryUsage();
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
          await options.stop(session);
        } catch {
          cleanupFailed = true;
        }
      }
      try {
        await options.disable(session);
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
    return {
      status: "complete",
      result: options.sanitize(profile!, packageRoot, {
        durationMs,
        before: before!,
        after: after!,
      }),
    };
  } catch (error) {
    return unavailable(error instanceof ProfileFailure ? error.reason : "invalid-profile");
  }
}
