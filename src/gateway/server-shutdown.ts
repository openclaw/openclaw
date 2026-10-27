import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { PluginRuntimeCloseRetainedError } from "../plugins/runtime-close-error.js";
import { settlesWithin } from "../shared/settle-within.js";
import { measureGatewayCloseStep } from "./restart-trace.js";
import type { GatewayCloseOptions } from "./server-public.js";

export function recordGatewayShutdownWarning(warnings: string[], name: string): void {
  if (!warnings.includes(name)) {
    warnings.push(name);
  }
}

/** Shutdown is published before ingress closes; absent restart metadata stays absent. */
export function resolveGatewayShutdownNotice(options?: GatewayCloseOptions) {
  const restartExpectedMs = options?.restartExpectedMs;
  return {
    reason: normalizeOptionalString(options?.reason) || "gateway stopping",
    ...(typeof restartExpectedMs === "number" && Number.isFinite(restartExpectedMs)
      ? { restartExpectedMs: Math.max(0, Math.floor(restartExpectedMs)) }
      : {}),
  };
}

type GatewayShutdownStep = {
  name: string;
  run: () => Promise<void> | void;
  required?: true;
};

/** Cleanup leftovers require process exit, but are not a failed external stop. */
export class GatewayShutdownCleanupRetainedError extends AggregateError {
  constructor(errors: unknown[], message = "Gateway cleanup resources remain after grace") {
    super(errors, message);
    this.name = "GatewayShutdownCleanupRetainedError";
  }
}

export function isGatewayCleanupRetainedError(error: unknown): boolean {
  if (
    error instanceof GatewayShutdownCleanupRetainedError ||
    error instanceof PluginRuntimeCloseRetainedError
  ) {
    return true;
  }
  return (
    error instanceof AggregateError &&
    error.errors.length > 0 &&
    error.errors.every(isGatewayCleanupRetainedError)
  );
}

/** Fatal errors keep their status even when another owner still retains resources. */
export function hasGatewayCleanupRetainedError(error: unknown): boolean {
  return collectNestedErrorCandidates(error).some(isGatewayCleanupRetainedError);
}

// Healthy global retirement measured 2327ms; allow headroom without the old 80s wait.
const CLEANUP_GRACE_MS = 5_000;

/** Startup failure and public close share the same ordered dependency joins. */
export async function runGatewayCloseSteps(params: {
  owner: {
    connectionWork: { drain: () => Promise<void> };
    stopConnectionDependentSidecars: GatewayShutdownStep["run"];
    stopRegisteredGatewayLifetimeSidecars: GatewayShutdownStep["run"];
    stopRegisteredPostReadySidecars: GatewayShutdownStep["run"];
    runClosePrelude: GatewayShutdownStep["run"];
    sealAndJoinRegisteredSidecarStops: GatewayShutdownStep["run"];
  };
  close: GatewayShutdownStep["run"];
  disposeTerminalSessions?: GatewayShutdownStep["run"];
  runStopHooks?: GatewayShutdownStep["run"];
  onError: (message: string) => void;
}): Promise<void> {
  const { owner } = params;
  const steps: GatewayShutdownStep[] = [
    {
      name: "connection-dependent sidecars",
      run: owner.stopConnectionDependentSidecars,
      required: true,
    },
    { name: "received connection work", run: () => owner.connectionWork.drain(), required: true },
    ...(params.disposeTerminalSessions
      ? [{ name: "terminal sessions", run: params.disposeTerminalSessions }]
      : []),
    { name: "gateway lifetime sidecars", run: owner.stopRegisteredGatewayLifetimeSidecars },
    { name: "post-ready sidecars", run: owner.stopRegisteredPostReadySidecars },
    ...(params.runStopHooks
      ? [{ name: "gateway_stop plugin hooks", run: params.runStopHooks }]
      : []),
    { name: "gateway close prelude", run: owner.runClosePrelude },
    {
      name: "late sidecar cleanup",
      run: owner.sealAndJoinRegisteredSidecarStops,
      required: true,
    },
    { name: "gateway close", run: params.close },
  ];
  // Collect owner failures, but never release dependencies beyond a failed required join.
  const errors: Error[] = [];
  const leftovers: unknown[] = [];
  for (const step of steps) {
    try {
      // Trace consumers parse one phase token; keep the human label for errors.
      const phase = `shutdown.${step.name.replace(/\s+/gu, "-")}`;
      const pending = measureGatewayCloseStep(phase, () => step.run());
      const graceMs = step.name === "gateway close" ? 10_000 : CLEANUP_GRACE_MS;
      if (!(await settlesWithin(pending, graceMs))) {
        const message = `${step.name} cleanup exceeded ${graceMs}ms; resources remain`;
        params.onError(message);
        leftovers.push(new Error(message));
        // Dependencies of a retained connection writer cannot be disposed safely.
        if (step.required) {
          break;
        }
      }
    } catch (error) {
      const message = `shutdown step failed (${step.name}): ${formatErrorMessage(error)}`;
      params.onError(message);
      if (isGatewayCleanupRetainedError(error)) {
        leftovers.push(error);
        if (step.required) {
          break;
        }
        continue;
      }
      errors.push(new Error(message, { cause: error }));
      if (step.required) {
        break;
      }
    }
  }
  if (leftovers.length > 0) {
    const retained = new GatewayShutdownCleanupRetainedError(leftovers);
    if (errors.length === 0) {
      throw retained;
    }
    errors.push(retained);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Gateway shutdown did not complete cleanly");
  }
}

/** Failed acquisition retains its owner when native cleanup cannot finish. */
export class GatewayStartupCleanupError extends AggregateError {
  constructor(startupError: unknown, cleanupError: unknown) {
    super([startupError, cleanupError], formatErrorMessage(startupError), { cause: startupError });
    this.name = "GatewayStartupCleanupError";
  }
}

export async function rethrowGatewayStartupError(
  error: unknown,
  cleanup: () => Promise<void> | void,
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new GatewayStartupCleanupError(error, cleanupError);
  }
  throw error;
}
