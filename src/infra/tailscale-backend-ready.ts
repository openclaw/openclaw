import { setTimeout as sleep } from "node:timers/promises";
import { asNullableObjectRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { runExec } from "../process/exec.js";
import { isAbortError } from "./abort-signal.js";
import { TAILSCALE_BACKEND_AUTH_REQUIRED_REASON } from "./tailscale-backend-auth-required-error.js";
import { TailscaleBackendStoppedError } from "./tailscale-backend-stopped-error.js";

const TAILSCALE_BACKEND_READY_WAIT_MS = 90_000;
const TAILSCALE_BACKEND_READY_POLL_MS = 2_000;
const TAILSCALE_PREREQUISITE_RECOVERY_MIN_POLL_MS = 1_000;
const TAILSCALE_PREREQUISITE_RECOVERY_MAX_POLL_MS = 30_000;
/** Backend states the daemon reports only while it is still coming up after boot. */
const TAILSCALE_BOOTING_BACKEND_STATES = new Set(["NoState", "Starting"]);
type TailscaleOperatorActionBackendState = "NeedsLogin" | "NeedsMachineAuth";

function isTailscaleOperatorActionBackendState(
  state: unknown,
): state is TailscaleOperatorActionBackendState {
  return state === "NeedsLogin" || state === "NeedsMachineAuth";
}

export type TailscaleManagedMode = "serve" | "funnel";

export type TailscaleStatusCommand = {
  bin: string;
  prefix: readonly string[];
};

export class TailscaleBackendAuthenticationRequiredError extends Error {
  readonly code = TAILSCALE_BACKEND_AUTH_REQUIRED_REASON;

  constructor(
    readonly backendState: "NeedsLogin" | "NeedsMachineAuth",
    readonly managedMode: TailscaleManagedMode,
    readonly statusCommand: TailscaleStatusCommand,
  ) {
    const action = backendState === "NeedsLogin" ? "sign in to" : "approve";
    super(`Tailscale backend requires the operator to ${action} the local node (${backendState})`);
    this.name = "TailscaleBackendAuthenticationRequiredError";
  }
}

export function isTailscaleServeAuthenticationRequiredError(
  error: unknown,
): error is TailscaleBackendAuthenticationRequiredError {
  return (
    error instanceof TailscaleBackendAuthenticationRequiredError && error.managedMode === "serve"
  );
}

export function isTailscaleBackendAuthenticationRequiredError(
  error: unknown,
): error is TailscaleBackendAuthenticationRequiredError {
  return error instanceof TailscaleBackendAuthenticationRequiredError;
}

export function parsePossiblyNoisyJsonObject(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const json = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  // SAFETY: callers only read string/object fields defensively from Tailscale's output.
  return JSON.parse(json) as Record<string, unknown>;
}

async function readTailscaleBackendState(
  exec: typeof runExec,
  bin: string,
  prefix: string[] | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const { stdout } = await exec(bin, [...(prefix ?? []), "status", "--json"], {
      timeoutMs: 5_000,
      maxBuffer: 16 * 1024 * 1024,
      logOutput: false,
      signal,
    });
    const parsed = stdout ? parsePossiblyNoisyJsonObject(stdout) : {};
    return typeof parsed.BackendState === "string" ? parsed.BackendState : undefined;
  } catch (error) {
    signal?.throwIfAborted();
    const state = parseRejectedAuthenticationState(error);
    if (state) {
      return state;
    }
    throw error;
  }
}

function parseRejectedAuthenticationState(
  error: unknown,
): TailscaleOperatorActionBackendState | undefined {
  const record = readRecord(error);
  if (
    isAbortError(error) ||
    record?.timedOut === true ||
    (record?.exitCode !== 1 && record?.code !== 1) ||
    typeof record?.stdout !== "string" ||
    record.code === "EACCES" ||
    record.code === "EPERM"
  ) {
    return undefined;
  }
  const detail = [error instanceof Error ? error.message : undefined, record.stderr, record.stdout]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  if (/permission denied|not permitted|access denied/i.test(detail)) {
    return undefined;
  }
  try {
    const parsed = parsePossiblyNoisyJsonObject(record.stdout);
    const state = parsed.BackendState;
    return isTailscaleOperatorActionBackendState(state) ? state : undefined;
  } catch {
    return undefined;
  }
}

export function isTransientTailscaleStatusError(error: unknown): boolean {
  const record = readRecord(error);
  const detail = [
    error instanceof Error ? error.message : undefined,
    typeof record?.stderr === "string" ? record.stderr : undefined,
    typeof record?.stdout === "string" ? record.stdout : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLowerCase();

  // The CLI's connect failure wording varies by platform and version: "local tailscaled",
  // "local tailscaled process", "local Tailscale service", "local Tailscale daemon". The
  // shared prefix is the stable contract (tailscale/cmd/tailscale/cli/diag.go).
  return (
    record?.timedOut === true ||
    detail.includes("failed to connect to local tailscale") ||
    detail.includes("connection refused") ||
    detail.includes("503 service unavailable")
  );
}

/**
 * Wait, bounded, while the local daemon is still booting (`NoState`/`Starting`, or not yet
 * accepting connections). A stopped daemon throws a typed prerequisite failure. Other
 * states, an unreadable status, or the deadline return
 * immediately so the route claim itself reports the authoritative error.
 */
export async function waitForTailscaleBackendReady(params: {
  bin: string;
  prefix?: string[];
  managedMode: TailscaleManagedMode;
  info: (message: string) => void;
  exec?: typeof runExec;
  deadlineMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const exec = params.exec ?? runExec;
  const pollMs = params.pollMs ?? TAILSCALE_BACKEND_READY_POLL_MS;
  const deadline = Date.now() + (params.deadlineMs ?? TAILSCALE_BACKEND_READY_WAIT_MS);
  let announced: string | undefined;
  for (;;) {
    params.signal?.throwIfAborted();
    let pending: string;
    try {
      const state = await readTailscaleBackendState(exec, params.bin, params.prefix, params.signal);
      if (state === "Stopped") {
        throw new TailscaleBackendStoppedError();
      }
      if (isTailscaleOperatorActionBackendState(state)) {
        throw new TailscaleBackendAuthenticationRequiredError(state, params.managedMode, {
          bin: params.bin,
          prefix: [...(params.prefix ?? [])],
        });
      }
      if (state === undefined || !TAILSCALE_BOOTING_BACKEND_STATES.has(state)) {
        return;
      }
      pending = state;
    } catch (error) {
      params.signal?.throwIfAborted();
      if (
        error instanceof TailscaleBackendAuthenticationRequiredError ||
        error instanceof TailscaleBackendStoppedError
      ) {
        throw error;
      }
      if (!isTransientTailscaleStatusError(error)) {
        return;
      }
      pending = "daemon not reachable";
    }
    if (Date.now() >= deadline) {
      return;
    }
    if (announced !== pending) {
      params.info(`waiting for the local Tailscale daemon (${pending})`);
      announced = pending;
    }
    await sleep(pollMs, undefined, { signal: params.signal }).finally(() =>
      params.signal?.throwIfAborted(),
    );
  }
}

/** Wait for the exact prerequisite that failed to become usable, without changing it. */
export async function waitForTailscaleBackendRunning(params: {
  bin: string;
  prefix?: string[];
  info: (message: string) => void;
  signal: AbortSignal;
}): Promise<boolean> {
  const maxPollMs = TAILSCALE_PREREQUISITE_RECOVERY_MAX_POLL_MS;
  let pollMs = TAILSCALE_PREREQUISITE_RECOVERY_MIN_POLL_MS;
  let announced: string | undefined;
  for (;;) {
    params.signal.throwIfAborted();
    let state: string | undefined;
    try {
      state = await readTailscaleBackendState(runExec, params.bin, params.prefix, params.signal);
    } catch (error) {
      params.signal.throwIfAborted();
      if (!isTransientTailscaleStatusError(error)) {
        throw error;
      }
      state = "daemon not reachable";
    }
    if (state === undefined) {
      throw new Error("Tailscale status did not include a backend state");
    }
    if (state === "Running") {
      params.signal.throwIfAborted();
      return true;
    }
    if (state === "Stopped") {
      params.info(
        "Tailscale is stopped; automatic Gateway startup recovery is not enabled for this state",
      );
      return false;
    }
    if (
      state !== "daemon not reachable" &&
      !TAILSCALE_BOOTING_BACKEND_STATES.has(state) &&
      !isTailscaleOperatorActionBackendState(state)
    ) {
      throw new Error(
        `Tailscale backend is not eligible for automatic startup recovery (${state})`,
      );
    }
    if (announced !== state) {
      params.info(`waiting for Tailscale operator action or backend recovery (${state})`);
      announced = state;
    }
    await sleep(pollMs, undefined, { signal: params.signal });
    pollMs = Math.min(pollMs * 2, maxPollMs);
  }
}
