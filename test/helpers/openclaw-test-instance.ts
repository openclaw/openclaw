// OpenClaw test instance helper spawns isolated OpenClaw processes.
import { type ChildProcess, type ChildProcessByStdio, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata-paths.mts";
import {
  hasUnjoinedWork,
  finalizeManagedChild,
  inspectManagedProcessGroup,
  runManagedCommand,
  loadManagedChildSpawner,
  terminateManagedChild,
} from "../../scripts/lib/managed-child-process.mts";
import { hasErrnoCode } from "../../src/infra/errno.js";
import { createFileLockManager } from "../../src/infra/file-lock-manager.js";
import { FILE_LOCK_TIMEOUT_ERROR_CODE } from "../../src/infra/file-lock.js";
import { isLockOwnerDefinitelyStale } from "../../src/infra/stale-lock-file.js";
import {
  appendCapturedOutput,
  createCapturedOutputBuffers,
  finalizeCapturedOutput,
  resolveMaxOutputBytes,
} from "../../src/process/exec-output.js";
import { getFileLockProcessStartTime } from "../../src/shared/pid-alive.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../src/test-utils/openclaw-test-state.js";
import { getDeterministicFreePortBlock } from "../../src/test-utils/ports.js";
import { sleep } from "../../src/utils.js";
import { decodeUtf8Tail } from "./bounded-child-output.js";
import { runQaGatewayFixture } from "./qa-gateway-cleanup.js";

type OpenClawTestStateOptions = NonNullable<Parameters<typeof createOpenClawTestState>[0]>;

type OpenClawTestInstanceOptions = {
  name: string;
  cwd?: string;
  entrypoint?: string[];
  port?: number;
  gatewayToken?: string;
  hookToken?: string;
  config?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  state?: Omit<OpenClawTestStateOptions, "applyEnv" | "gateway" | "env" | "verifyCleanup">;
  gatewayArgs?: string[];
  gatewayCommandPrefix?: string[];
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  signal?: AbortSignal;
  verifyCleanup?: (cleanup: () => Promise<void>) => Promise<void>;
};

type OpenClawTestInstanceCommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type OpenClawTestProcess = ChildProcessByStdio<null, Readable, Readable>;

export type OpenClawTestInstance = {
  name: string;
  port: number;
  url: string;
  hookToken: string;
  gatewayToken: string;
  homeDir: string;
  stateDir: string;
  configPath: string;
  state: OpenClawTestState;
  stdout: string[];
  stderr: string[];
  readonly readiness: readonly GatewayReadinessDiagnostic[];
  child?: OpenClawTestProcess;
  env: NodeJS.ProcessEnv;
  entrypoint: () => Promise<string[]>;
  cli: (
    args: string[],
    options?: { timeoutMs?: number; execPath?: string },
  ) => Promise<OpenClawTestInstanceCommandResult>;
  startGateway: () => Promise<void>;
  stopGateway: () => Promise<void>;
  logs: () => string;
  cleanup: () => Promise<void>;
};

type ReadinessProbe = {
  attempt: number;
  phase: "headers" | "body" | "complete";
  elapsedMs: number;
  status?: number;
  ready?: boolean;
  failing?: string[];
  omittedFailing?: number;
  error?: "timeout" | "child-exit" | "fetch-failed" | "invalid-json" | "body-failed" | "aborted";
};

export type GatewayReadinessDiagnostic = {
  probe: "GET /readyz";
  startedAtMs: number;
  deadlineMs: number;
  elapsedMs: number;
  outcome: "ready" | "timeout" | "child-exit" | "aborted";
  attempts: number;
  probes: Array<ReadinessProbe & { startedAtMs: number; deadlineMs: number }>;
  omittedProbes: number;
  lastProbe: ReadinessProbe | null;
  lastFailedResponse: Pick<
    ReadinessProbe,
    "attempt" | "phase" | "elapsedMs" | "status" | "ready" | "error"
  > | null;
  child: { pid: number | null; exitCode: number | null; signalCode: NodeJS.Signals | null };
  logs: { stdout: string; stderr: string } | null;
};

const GATEWAY_START_TIMEOUT_MS = 60_000;
const GATEWAY_STOP_TIMEOUT_MS = 1_500;
const GATEWAY_ENTRYPOINT_PREPARE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 30_000;
const LOG_TAIL_MAX_BYTES = 256 * 1024;
const GATEWAY_MIGRATION_CONVERGENCE_MAX_RESTARTS = 1;
const GATEWAY_MIGRATION_CONVERGENCE_REFUSAL_PREFIX =
  "OpenClaw plugin migration inputs changed during startup convergence;";
const GATEWAY_MIGRATION_CONVERGENCE_RESTART_MARKER =
  "[openclaw-test-instance] restarting gateway after migration convergence refusal\n";
const entrypointPromises = new Map<string, Promise<string[]>>();

type BoundedStringLog = string[] & {
  maxBytes?: number;
  byteLength?: number;
  truncated?: boolean;
};

type OpenClawTestProcessReadiness = Pick<OpenClawTestProcess, "pid" | "exitCode" | "signalCode"> & {
  once: (event: "exit", listener: () => void) => unknown;
  off: (event: "exit", listener: () => void) => unknown;
};
type GatewayProcessStopOptions = NonNullable<Parameters<typeof terminateManagedChild>[2]> & {
  forceWindowsTree?: boolean;
};
type TaskkillResult = Exclude<
  ReturnType<NonNullable<GatewayProcessStopOptions["runTaskkill"]>>,
  undefined
> & {
  signal?: NodeJS.Signals | null;
};

function createBoundedStringLog(maxBytes = LOG_TAIL_MAX_BYTES): string[] {
  const log = [] as BoundedStringLog;
  log.maxBytes = Math.max(1, maxBytes);
  log.byteLength = 0;
  log.truncated = false;
  return log;
}

function appendLogChunk(log: string[], chunk: unknown): void {
  const chunks = log as BoundedStringLog;
  const limit = chunks.maxBytes ?? LOG_TAIL_MAX_BYTES;
  const text = String(chunk);
  const textBytes = Buffer.byteLength(text);
  if (textBytes > limit) {
    const buffer = Buffer.from(text);
    const tail = decodeUtf8Tail(buffer.subarray(buffer.length - limit));
    chunks.splice(0, chunks.length, tail);
    chunks.byteLength = Buffer.byteLength(tail);
    chunks.truncated = true;
    return;
  }

  chunks.push(text);
  chunks.byteLength = (chunks.byteLength ?? 0) + textBytes;
  while ((chunks.byteLength ?? 0) > limit && chunks.length > 0) {
    const first = chunks[0] ?? "";
    const firstBytes = Buffer.byteLength(first);
    const overflow = (chunks.byteLength ?? 0) - limit;
    if (firstBytes <= overflow) {
      chunks.shift();
      chunks.byteLength = (chunks.byteLength ?? 0) - firstBytes;
      chunks.truncated = true;
      continue;
    }

    const buffer = Buffer.from(first);
    // Drop a split prefix instead of expanding it into replacement bytes that can stall trimming.
    const tail = decodeUtf8Tail(buffer.subarray(overflow));
    chunks[0] = tail;
    chunks.byteLength = chunks.reduce((total, entry) => total + Buffer.byteLength(entry), 0);
    chunks.truncated = true;
  }
}

function readLogBuffer(log: string[]): string {
  const text = log.join("");
  return (log as BoundedStringLog).truncated
    ? `[output truncated to last ${(log as BoundedStringLog).maxBytes ?? LOG_TAIL_MAX_BYTES} bytes]\n${text}`
    : text;
}

function isGatewayMigrationConvergenceRefusal(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): boolean {
  return (
    code === 1 &&
    signal === null &&
    stderr
      .split(/\r?\n/u)
      .some((line) => line.startsWith(GATEWAY_MIGRATION_CONVERGENCE_REFUSAL_PREFIX))
  );
}

async function resolveBuiltGatewayEntrypoint(cwd: string): Promise<string[] | null> {
  const buildStampPath = path.join(cwd, "dist", BUILD_STAMP_FILE);
  const runtimePostBuildStampPath = path.join(cwd, "dist", RUNTIME_POSTBUILD_STAMP_FILE);
  for (const entrypoint of ["dist/index.js", "dist/index.mjs"]) {
    try {
      await Promise.all([
        fs.access(path.join(cwd, entrypoint)),
        fs.access(buildStampPath),
        fs.access(runtimePostBuildStampPath),
      ]);
      return [entrypoint];
    } catch {
      // try the next built entrypoint
    }
  }
  return null;
}

async function prepareGatewayEntrypoint(cwd: string): Promise<string[]> {
  const builtEntrypoint = await resolveBuiltGatewayEntrypoint(cwd);
  if (builtEntrypoint) {
    return builtEntrypoint;
  }

  // Share command ownership so successful preparation cannot retain its deadline.
  const completed = await runCommand({
    args: ["node", "scripts/run-node.mjs", "--help"],
    cwd,
    env: { ...process.env, VITEST: "1" },
    timeoutMs: GATEWAY_ENTRYPOINT_PREPARE_TIMEOUT_MS,
  });
  if (completed.code !== 0) {
    throw new Error(
      `failed preparing gateway entrypoint (code=${String(completed.code)} signal=${String(
        completed.signal,
      )})\n${formatLogs([completed.stdout], [completed.stderr])}`,
    );
  }

  return (await resolveBuiltGatewayEntrypoint(cwd)) ?? ["scripts/run-node.mjs"];
}

async function resolveGatewayEntrypoint(cwd: string): Promise<string[]> {
  let promise = entrypointPromises.get(cwd);
  if (!promise) {
    promise = prepareGatewayEntrypoint(cwd);
    entrypointPromises.set(cwd, promise);
  }
  return await promise;
}

const portClaims = createFileLockManager("openclaw.test-gateway-ports");
let portClaimOwnerStartTime: number | null | undefined;
const isDefinitelyStalePortClaim = ({ payload }: { payload: unknown }) =>
  isLockOwnerDefinitelyStale({ payload: isRecord(payload) ? payload : null });

async function claimGatewayPortBlock(port: number): Promise<() => Promise<void>> {
  const root = await fs.realpath(tmpdir());
  const claims: Awaited<ReturnType<typeof portClaims.acquire>>[] = [];
  const release = () =>
    runQaGatewayFixture(async () => {}, ...claims.map((claim) => () => claim.release()));
  try {
    for (const candidate of [port, port + 1]) {
      claims.push(
        await portClaims.acquire(path.join(root, `openclaw-test-port-${candidate}`), {
          retry: { retries: 0 },
          staleMs: 30_000,
          staleRecovery: "remove-if-unchanged",
          shouldReclaim: isDefinitelyStalePortClaim,
          shouldRemoveStaleLock: isDefinitelyStalePortClaim,
          payload: () => {
            if (portClaimOwnerStartTime === undefined) {
              portClaimOwnerStartTime = getFileLockProcessStartTime(process.pid);
            }
            return {
              pid: process.pid,
              createdAt: new Date().toISOString(),
              ...(portClaimOwnerStartTime === null ? {} : { starttime: portClaimOwnerStartTime }),
            };
          },
        }),
      );
    }
    return release;
  } catch (error) {
    return runQaGatewayFixture(async (): Promise<never> => {
      throw error;
    }, release);
  }
}

async function reserveGatewayPort(
  port: number,
  verifyCleanup?: OpenClawTestInstanceOptions["verifyCleanup"],
) {
  // A probe must not retain a connection that can delay release before spawn.
  const server = net.createServer((socket) => socket.destroy());
  const release = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    return { release };
  } catch (error) {
    return await runQaGatewayFixture(
      async (): Promise<never> => {
        throw error;
      },
      () => (server.listening ? (verifyCleanup ? verifyCleanup(release) : release()) : undefined),
    );
  }
}

export function formatGatewayReadinessDiagnostic(
  diagnostic: Pick<
    GatewayReadinessDiagnostic,
    "attempts" | "elapsedMs" | "lastProbe" | "lastFailedResponse" | "child"
  >,
): string {
  const { attempts, elapsedMs, lastProbe, lastFailedResponse, child } = diagnostic;
  return `[openclaw-test-instance] readiness ${JSON.stringify({
    attempts,
    elapsedMs,
    lastProbe,
    lastFailedResponse,
    child,
  })}`;
}

async function waitForGatewayReady(
  proc: OpenClawTestProcessReadiness,
  chunksOut: string[],
  chunksErr: string[],
  port: number,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  record?: (diagnostic: GatewayReadinessDiagnostic) => void,
) {
  const startedAt = Date.now();
  const probes: GatewayReadinessDiagnostic["probes"] = [];
  let outcome: GatewayReadinessDiagnostic["outcome"] = "timeout";
  let attempts = 0;
  let lastProbe: ReadinessProbe | undefined;
  let lastFailedResponse: GatewayReadinessDiagnostic["lastFailedResponse"] = null;
  const startupError = (message: string, probe = lastProbe) =>
    new Error(
      `${message}\n${formatGatewayReadinessDiagnostic({
        attempts,
        elapsedMs: Date.now() - startedAt,
        lastProbe: probe ?? null,
        lastFailedResponse,
        child: { pid: proc.pid ?? null, exitCode: proc.exitCode, signalCode: proc.signalCode },
      })}\n${formatLogs(chunksOut, chunksErr)}`,
    );
  const exitedBeforeReadinessError = (probe = lastProbe) =>
    startupError(
      `gateway exited before readiness (code=${String(proc.exitCode)} signal=${String(
        proc.signalCode,
      )})`,
      probe,
    );
  try {
    while (Date.now() - startedAt < timeoutMs) {
      signal?.throwIfAborted();
      if (hasChildExited(proc)) {
        throw exitedBeforeReadinessError();
      }

      const attemptStartedAt = Date.now();
      const remainingMs = timeoutMs - (attemptStartedAt - startedAt);
      if (remainingMs <= 0) {
        break;
      }
      const attemptTimeoutMs = Math.min(1_000, Math.max(1, remainingMs));
      const probe: ReadinessProbe = { attempt: ++attempts, phase: "headers", elapsedMs: 0 };
      const probeAbort = new AbortController();
      const abortProbe = () => probeAbort.abort(signal?.reason);
      signal?.addEventListener("abort", abortProbe, { once: true });
      if (signal?.aborted) {
        abortProbe();
      }
      let attemptTimeout: ReturnType<typeof setTimeout> | undefined;
      let handleExit = () => {};
      const exitPromise = new Promise<never>((_resolve, reject) => {
        handleExit = () => {
          probe.error = "child-exit";
          probe.elapsedMs = Date.now() - attemptStartedAt;
          const error = exitedBeforeReadinessError(probe);
          probeAbort.abort(error);
          reject(error);
        };
        proc.once("exit", handleExit);
      });
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        attemptTimeout = setTimeout(() => {
          probe.error = "timeout";
          const error = new Error("gateway readiness probe timed out");
          probeAbort.abort(error);
          reject(error);
        }, attemptTimeoutMs);
        attemptTimeout.unref?.();
      });
      try {
        // A dead child cannot complete readiness. Race the owner lifecycle against
        // both HTTP headers and body parsing so a stuck probe never hides its exit.
        const ready = await Promise.race([
          (async () => {
            const response = await fetchImpl(`http://127.0.0.1:${port}/readyz`, {
              signal: probeAbort.signal,
            });
            probe.status = response.status;
            probe.phase = "body";
            const readiness: unknown = await response.json();
            probe.phase = "complete";
            if (isRecord(readiness)) {
              if (typeof readiness.ready === "boolean") {
                probe.ready = readiness.ready;
              }
              if (Array.isArray(readiness.failing)) {
                // Channel IDs and arbitrary startup reasons are private; retain only core categories.
                probe.failing = readiness.failing.slice(0, 8).map((reason) => {
                  switch (reason) {
                    case "startup-sidecars":
                    case "gateway-draining":
                    case "state-database":
                    case "internal":
                      return reason;
                    default:
                      return "other";
                  }
                });
                probe.omittedFailing = Math.max(0, readiness.failing.length - 8);
              }
            }
            return response.ok && isRecord(readiness) && readiness.ready === true;
          })(),
          exitPromise,
          timeoutPromise,
        ]);
        signal?.throwIfAborted();
        if (ready) {
          outcome = "ready";
          return;
        }
      } catch (error) {
        signal?.throwIfAborted();
        probe.elapsedMs = Date.now() - attemptStartedAt;
        if (hasChildExited(proc)) {
          probe.error ??= "child-exit";
          throw exitedBeforeReadinessError(probe);
        }
        probe.error ??=
          probe.phase === "headers"
            ? "fetch-failed"
            : error instanceof SyntaxError
              ? "invalid-json"
              : "body-failed";
        // keep polling
      } finally {
        // A fetch that ignores abort may finish later; keep its mutations out of the retained receipt.
        if (signal?.aborted) {
          probe.error ??= "aborted";
        }
        lastProbe = { ...probe, elapsedMs: Date.now() - attemptStartedAt };
        // Preserve a completed failure when the budget's final probe stalls. Keep
        // only scalar categories, never response bodies, headers, or error text.
        if (
          lastProbe.status !== undefined &&
          outcome !== "ready" &&
          (!lastProbe.error ||
            lastProbe.error === "invalid-json" ||
            lastProbe.error === "body-failed")
        ) {
          const { attempt, phase, elapsedMs, status, ready, error } = lastProbe;
          lastFailedResponse = { attempt, phase, elapsedMs, status, ready, error };
        }
        // The 60-second desktop wait cannot exceed this bound at its existing 10ms cadence.
        if (probes.length < 8192) {
          probes.push({
            ...lastProbe,
            startedAtMs: attemptStartedAt,
            deadlineMs: attemptStartedAt + attemptTimeoutMs,
          });
        }
        if (attemptTimeout) {
          clearTimeout(attemptTimeout);
        }
        proc.off("exit", handleExit);
        signal?.removeEventListener("abort", abortProbe);
      }

      const delayMs = Math.min(10, timeoutMs - (Date.now() - startedAt));
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
    signal?.throwIfAborted();
    throw startupError(`timeout waiting for gateway readiness on port ${port}`);
  } finally {
    record?.({
      probe: "GET /readyz",
      startedAtMs: startedAt,
      deadlineMs: startedAt + timeoutMs,
      elapsedMs: Date.now() - startedAt,
      outcome: signal?.aborted ? "aborted" : hasChildExited(proc) ? "child-exit" : outcome,
      attempts,
      probes,
      omittedProbes: attempts - probes.length,
      lastProbe: lastProbe ?? null,
      lastFailedResponse,
      child: { pid: proc.pid ?? null, exitCode: proc.exitCode, signalCode: proc.signalCode },
      logs: outcome === "ready" ? null : { stdout: chunksOut.join(""), stderr: chunksErr.join("") },
    });
  }
}

function hasGatewayProcessClosed(child: OpenClawTestProcess, platform: NodeJS.Platform): boolean {
  // Descendants need not inherit stdio. Release the owner only after its group
  // is positively dead; closed pipes or an indeterminate census are insufficient.
  return (
    hasChildExited(child) &&
    child.stdout.closed &&
    child.stderr.closed &&
    inspectManagedProcessGroup(child, { errorPolicy: "indeterminate", platform }) === "dead"
  );
}

async function waitForGatewayClose(
  child: OpenClawTestProcess,
  timeoutMs: number,
  platform: NodeJS.Platform,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (!hasGatewayProcessClosed(child, platform) && Date.now() < deadline) {
    await sleep(Math.min(10, deadline - Date.now()));
  }
  return hasGatewayProcessClosed(child, platform);
}

async function stopGatewayProcess(
  child: OpenClawTestProcess,
  deadline: number,
  stopTimeoutMs: number,
  options: GatewayProcessStopOptions = {},
  stopLog: string[] = [],
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const waitForClose = (remainingSteps: number) =>
    waitForGatewayClose(
      child,
      Math.min(
        stopTimeoutMs,
        Math.max(0, Math.floor((deadline - Date.now()) / Math.max(1, remainingSteps))),
      ),
      platform,
    );
  const terminate = (signal: NodeJS.Signals) =>
    terminateManagedChild(
      child,
      signal,
      options.runTaskkill
        ? { platform, runTaskkill: options.runTaskkill }
        : {
            platform,
          },
    );

  const signals = ["SIGTERM", "SIGKILL"] as const;
  // Preserve an exited leader's inherited output before terminating its writers.
  // Windows still finalizes the retained Job after drainage, including handle closure.
  if (hasChildExited(child) && (await waitForClose(signals.length + 1)) && platform !== "win32") {
    return true;
  }
  if (platform === "win32") {
    const startedAt = Date.now();
    const taskkill: Array<{
      force: boolean;
      elapsedMs: number;
      status?: number | null;
      signal?: NodeJS.Signals | null;
      errorCode?: string;
      threw?: boolean;
    }> = [];
    // At most the owner's TERM and force attempts; never retain command output or error text.
    const runTaskkill: NonNullable<GatewayProcessStopOptions["runTaskkill"]> = (...args) => {
      const attemptStartedAt = Date.now();
      let result: TaskkillResult | undefined;
      let threw = false;
      let error: unknown;
      try {
        result = (options.runTaskkill ?? spawnSync)(...args);
        return result;
      } catch (cause) {
        threw = true;
        error = cause;
        throw cause;
      } finally {
        taskkill.push({
          force: args[1].includes("/F"),
          elapsedMs: Date.now() - attemptStartedAt,
          status: result?.status,
          signal: result?.signal,
          errorCode: shutdownErrorCode(result?.error ?? error),
          ...(threw ? { threw } : {}),
        });
      }
    };
    const failed = (
      reason: "termination-indeterminate" | "close-incomplete" | "exception",
      error?: unknown,
    ) => {
      const diagnostic = {
        reason,
        pid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        stdoutClosed: child.stdout.closed,
        stderrClosed: child.stderr.closed,
        elapsedMs: Date.now() - startedAt,
        taskkill,
        errorCode: shutdownErrorCode(error),
      };
      appendLogChunk(
        stopLog,
        `[openclaw-test-instance] Windows shutdown ${JSON.stringify(diagnostic)}\n`,
      );
      return false;
    };
    if (Date.now() >= deadline) {
      return failed("close-incomplete");
    }
    // Taskkill owns its bounded synchronous TERM/force sequence. Node cannot observe
    // exit or pipe closure until it returns, so charge the existing close allowance afterward.
    try {
      await finalizeManagedChild(child, options.forceWindowsTree ? "SIGKILL" : "SIGTERM", {
        platform,
        runTaskkill,
        forceKillDelayMs: 0,
        drainTimeoutMs: stopTimeoutMs,
        retainOutputOnFailure: true,
      });
      return true;
    } catch (error) {
      failed("exception", error);
      throw error;
    }
  }
  for (const [index, signal] of signals.entries()) {
    if (hasGatewayProcessClosed(child, platform)) {
      return true;
    }
    if (Date.now() >= deadline) {
      break;
    }
    try {
      terminate(signal);
    } catch {
      // ignore
    }
    if (await waitForClose(signals.length - index)) {
      return true;
    }
  }
  return hasGatewayProcessClosed(child, platform);
}

function shutdownErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code.slice(0, 128) : undefined;
}

function hasChildExited(child: Pick<OpenClawTestProcess, "exitCode" | "signalCode">) {
  return child.exitCode !== null || child.signalCode !== null;
}

function mergeConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!override) {
    return base;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    result[key] = isRecord(existing) && isRecord(value) ? mergeConfig(existing, value) : value;
  }
  return result;
}

function formatLogs(stdout: string[], stderr: string[]): string {
  const diagnosticTail = (log: string[]): string => {
    const tail = createBoundedStringLog(
      Math.min((log as BoundedStringLog).maxBytes ?? LOG_TAIL_MAX_BYTES, LOG_TAIL_MAX_BYTES),
    ) as BoundedStringLog;
    for (const chunk of log) {
      appendLogChunk(tail, chunk);
    }
    tail.truncated ||= (log as BoundedStringLog).truncated;
    return readLogBuffer(tail);
  };
  return `--- stdout ---\n${diagnosticTail(stdout)}\n--- stderr ---\n${diagnosticTail(stderr)}`;
}

function createInstanceEnv(params: {
  stateEnv: NodeJS.ProcessEnv;
  extraEnv: Record<string, string | undefined>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...params.stateEnv,
    OPENCLAW_GATEWAY_TOKEN: "",
    OPENCLAW_GATEWAY_PASSWORD: "",
    OPENCLAW_GATEWAY_PORT: "",
    OPENCLAW_GATEWAY_URL: "",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
    VITEST: "1",
  };
  for (const [key, value] of Object.entries(params.extraEnv)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

export async function createOpenClawTestInstance(
  options: OpenClawTestInstanceOptions,
): Promise<OpenClawTestInstance> {
  const cwd = options.cwd ?? process.cwd();
  const signal = options.signal;
  const verifyCleanup = options.verifyCleanup ?? ((cleanup: () => Promise<void>) => cleanup());
  let acceptingWork = !signal?.aborted;
  const closeAdmission = () => {
    acceptingWork = false;
  };
  const entrypoint = async () => {
    signal?.throwIfAborted();
    // Shared preparation remains joined for every borrower; one instance's
    // cancellation only refuses its own handoff and subsequent spawn.
    const prepared = options.entrypoint ?? (await resolveGatewayEntrypoint(cwd));
    signal?.throwIfAborted();
    return prepared;
  };
  let reservation: Awaited<ReturnType<typeof reserveGatewayPort>> | undefined;
  const releasePort = async () => {
    if (reservation) {
      await reservation.release();
      reservation = undefined;
    }
  };
  let releasePortClaims: (() => Promise<void>) | undefined;
  let port: number;
  const gatewayToken = options.gatewayToken ?? `gateway-${options.name}-${randomUUID()}`;
  const hookToken = options.hookToken ?? `token-${options.name}-${randomUUID()}`;
  let state: OpenClawTestState | undefined;
  signal?.addEventListener("abort", closeAdmission, { once: true });
  try {
    signal?.throwIfAborted();
    // The lazy sandbox uses port + 1; keep both listeners out of Linux's client-port pool.
    if (options.port !== undefined) {
      port = options.port;
    } else {
      const seen = new Set<number>();
      while (true) {
        signal?.throwIfAborted();
        port = await getDeterministicFreePortBlock({ offsets: [0, 1] });
        if (seen.has(port)) {
          throw new Error("no unclaimed test Gateway port block available");
        }
        seen.add(port);
        try {
          releasePortClaims = await claimGatewayPortBlock(port);
          break;
        } catch (error) {
          if (!hasErrnoCode(error, FILE_LOCK_TIMEOUT_ERROR_CODE)) {
            throw error;
          }
        }
      }
      reservation = await reserveGatewayPort(port, options.verifyCleanup);
    }
    signal?.throwIfAborted();
    state = await createOpenClawTestState({
      label: options.name,
      layout: "home",
      ...options.state,
      applyEnv: false,
      env: options.env,
      verifyCleanup: options.verifyCleanup,
    });
    signal?.throwIfAborted();
    await state.writeConfig(
      mergeConfig(
        {
          gateway: {
            port,
            auth: { mode: "token", token: gatewayToken },
            controlUi: { enabled: false },
          },
          hooks: { enabled: true, token: hookToken, path: "/hooks" },
        },
        options.config,
      ),
    );
    signal?.throwIfAborted();
  } catch (error) {
    // Neither owner is exposed until configuration succeeds; roll both back,
    // retaining the acquisition error even when a cleanup phase also fails.
    const acquiredState = state;
    try {
      return await runQaGatewayFixture(
        async (): Promise<never> => {
          throw error;
        },
        () => (acquiredState ? verifyCleanup(() => acquiredState.cleanup()) : undefined),
        () => (reservation ? verifyCleanup(releasePort) : undefined),
        () => (releasePortClaims ? verifyCleanup(releasePortClaims) : undefined),
      );
    } finally {
      signal?.removeEventListener("abort", closeAdmission);
    }
  }

  const stdout = createBoundedStringLog();
  const stderr = createBoundedStringLog();
  const readiness: GatewayReadinessDiagnostic[] = [];
  const env = createInstanceEnv({
    stateEnv: state.env,
    extraEnv: options.env ?? {},
  });
  let child: { process: OpenClawTestProcess; ready: boolean } | undefined;
  const commands = new Set<Promise<OpenClawTestInstanceCommandResult>>();
  const reserveIdlePort = async () => {
    if (options.port === undefined && acceptingWork && !reservation) {
      reservation = await reserveGatewayPort(port, options.verifyCleanup);
    }
  };
  let cleanupPromise: Promise<void> | undefined;
  let operation: { kind: "start" | "stop" | "cleanup"; promise: Promise<void> } | undefined;
  const enqueue = (kind: NonNullable<typeof operation>["kind"], action: () => Promise<void>) => {
    if (operation?.kind === kind) {
      return operation.promise;
    }
    // Claim ordering before preparation can yield. Teardown joins pending startup,
    // and another start cannot borrow readiness from a child being stopped.
    const next = {
      kind,
      promise: Promise.resolve(operation?.promise)
        .catch(() => undefined)
        .then(action),
    };
    operation = next;
    const release = () => {
      if (operation === next) {
        operation = undefined;
      }
    };
    void next.promise.then(release, release);
    return next.promise;
  };
  const stopTimeoutMs = options.stopTimeoutMs ?? GATEWAY_STOP_TIMEOUT_MS;
  const spawnGatewayProcess = (
    spawnManagedChild: Awaited<ReturnType<typeof loadManagedChildSpawner>>,
    args: string[],
    attemptStderr: string[],
  ): OpenClawTestProcess => {
    const [command = "node", ...prefixArgs] = options.gatewayCommandPrefix ?? [];
    signal?.throwIfAborted();
    const next = spawnManagedChild(command, [...prefixArgs, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: shouldUseOpenClawTestProcessGroup(),
    });
    next.stdout.setEncoding("utf8");
    next.stderr.setEncoding("utf8");
    next.once("error", (error) =>
      appendLogChunk(stderr, `gateway child startup error: ${error.message}\n`),
    );
    next.stdout.on("data", (chunk) => appendLogChunk(stdout, chunk));
    next.stderr.on("data", (chunk) => {
      appendLogChunk(stderr, chunk);
      appendLogChunk(attemptStderr, chunk);
    });
    return next;
  };
  const releaseGatewayChild = async (
    target: OpenClawTestProcess,
    deadline: number,
    stopOptions: GatewayProcessStopOptions = {},
  ): Promise<boolean> => {
    const closed = await stopGatewayProcess(target, deadline, stopTimeoutMs, stopOptions, stderr);
    if (closed && child?.process === target) {
      child = undefined;
    }
    return closed;
  };
  const stopGatewayChild = async (stopOptions: GatewayProcessStopOptions = {}) => {
    const target = child;
    if (!target) {
      await reserveIdlePort();
      return;
    }
    // A failed stop retains ownership, never the old readiness observation.
    target.ready = false;
    const closed = await releaseGatewayChild(
      target.process,
      Date.now() + stopTimeoutMs * 2,
      stopOptions,
    );
    if (!closed) {
      throw new Error(
        `gateway process cleanup could not verify termination and output closure\n${formatLogs(stdout, stderr)}`,
      );
    }
    await reserveIdlePort();
  };

  const instance: OpenClawTestInstance = {
    name: options.name,
    port,
    url: `ws://127.0.0.1:${port}`,
    hookToken,
    gatewayToken,
    homeDir: state.home,
    stateDir: state.stateDir,
    configPath: state.configPath,
    state,
    stdout,
    stderr,
    readiness,
    get child() {
      return child?.process;
    },
    env,
    entrypoint,
    cli: (args, commandOptions = {}) => {
      if (!acceptingWork) {
        return Promise.reject(new Error("test instance no longer accepts CLI commands"));
      }
      // Admit the whole operation before preparation yields. Failed process cleanup
      // retains its completion and closes admission until the instance is retired.
      const command = Promise.resolve().then(async () => {
        signal?.throwIfAborted();
        const commandEntrypoint = await entrypoint();
        signal?.throwIfAborted();
        return await runCommand({
          args: [commandOptions.execPath ?? "node", ...commandEntrypoint, ...args],
          cwd,
          env,
          timeoutMs: commandOptions.timeoutMs ?? COMMAND_TIMEOUT_MS,
          signal,
        });
      });
      commands.add(command);
      void command.then(
        () => commands.delete(command),
        (error: unknown) => {
          if (hasUnjoinedWork(error)) {
            acceptingWork = false;
          } else {
            commands.delete(command);
          }
        },
      );
      return command;
    },
    startGateway: () => {
      if (!acceptingWork) {
        return Promise.reject(new Error("test instance no longer accepts Gateway starts"));
      }
      return enqueue("start", async () => {
        signal?.throwIfAborted();
        if (child?.ready && !hasChildExited(child.process)) {
          return;
        }
        readiness.length = 0;
        const commandEntrypoint = await entrypoint();
        const spawnManagedChild = await loadManagedChildSpawner();
        signal?.throwIfAborted();
        const gatewayArgs = [
          ...commandEntrypoint,
          "gateway",
          "--port",
          String(port),
          "--bind",
          "loopback",
          "--allow-unconfigured",
          ...(options.gatewayArgs ?? []),
        ];
        await stopGatewayChild({ forceWindowsTree: true });
        signal?.throwIfAborted();
        const deadline = Date.now() + (options.startTimeoutMs ?? GATEWAY_START_TIMEOUT_MS);
        let restarts = 0;

        while (true) {
          signal?.throwIfAborted();
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            throw new Error(
              `timeout waiting for gateway readiness on port ${port}\n${formatLogs(stdout, stderr)}`,
            );
          }
          const attemptStderr = createBoundedStringLog();
          await releasePort();
          signal?.throwIfAborted();
          let attempt: OpenClawTestProcess;
          try {
            attempt = spawnGatewayProcess(spawnManagedChild, gatewayArgs, attemptStderr);
          } catch (error) {
            await runQaGatewayFixture(async (): Promise<never> => {
              throw error;
            }, reserveIdlePort);
            return;
          }
          const owner = { process: attempt, ready: false };
          child = owner;
          try {
            await waitForGatewayReady(
              attempt,
              stdout,
              stderr,
              port,
              remainingMs,
              fetch,
              signal,
              (diagnostic) => readiness.push(diagnostic),
            );
            signal?.throwIfAborted();
            owner.ready = true;
            return;
          } catch (err) {
            const exitCode = attempt.exitCode;
            const signalCode = attempt.signalCode;
            // Startup expiry stops retry admission, not ownership cleanup. Use the
            // same separate shutdown budget as explicit stop, retaining failed owners.
            let closed = false;
            const cleanupErrors: unknown[] = [];
            try {
              await verifyCleanup(async () => {
                closed = await releaseGatewayChild(attempt, Date.now() + stopTimeoutMs * 2, {
                  forceWindowsTree: true,
                });
                // The optional lifetime must retain failed rollback even if
                // startup never handed a process to its caller.
                if (!closed && options.verifyCleanup) {
                  throw new Error(
                    `gateway process cleanup could not verify termination and output closure\n${formatLogs(stdout, stderr)}`,
                    { cause: err },
                  );
                }
              });
              if (closed) {
                await reserveIdlePort();
              }
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError);
            }
            if (cleanupErrors.length > 0) {
              throw new AggregateError(
                [err, ...cleanupErrors],
                "gateway startup and cleanup failed",
                {
                  cause: err,
                },
              );
            }
            const shouldRestart =
              !signal?.aborted &&
              restarts < GATEWAY_MIGRATION_CONVERGENCE_MAX_RESTARTS &&
              isGatewayMigrationConvergenceRefusal(
                exitCode,
                signalCode,
                readLogBuffer(attemptStderr),
              );
            if (shouldRestart && closed && Date.now() < deadline) {
              restarts += 1;
              appendLogChunk(stderr, GATEWAY_MIGRATION_CONVERGENCE_RESTART_MARKER);
              continue;
            }
            throw err;
          }
        }
      });
    },
    stopGateway: () => enqueue("stop", stopGatewayChild),
    logs: () => formatLogs(stdout, stderr),
    cleanup: () => {
      acceptingWork = false;
      signal?.removeEventListener("abort", closeAdmission);
      // Commands may need the Gateway to finish. Drain them first, still attempt
      // Gateway shutdown on failure, and never turn an unverified drain into a retry success.
      return (cleanupPromise ??= enqueue("cleanup", async () => {
        await runQaGatewayFixture(
          async () => {
            const results = await Promise.allSettled(commands);
            const errors = results.flatMap((result) =>
              result.status === "rejected" && hasUnjoinedWork(result.reason) ? [result.reason] : [],
            );
            if (errors.length === 1) {
              throw errors[0];
            }
            if (errors.length > 1) {
              throw new AggregateError(
                errors,
                "CLI cleanup unverified; test instance state retained",
              );
            }
          },
          () => {
            // Terminal cleanup has no graceful-shutdown contract. Force the Windows
            // tree so inherited pipes cannot outlive the completed test instance.
            return stopGatewayChild({ forceWindowsTree: true });
          },
          releasePort,
        );
        await state.cleanup();
        // Keep the logical claim across the socket handoff, stop/restart, and
        // failed shutdown. Only verified terminal cleanup releases either port.
        if (releasePortClaims) {
          await verifyCleanup(releasePortClaims);
          releasePortClaims = undefined;
        }
      }));
    },
  };

  return instance;
}

async function runCommand(params: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<OpenClawTestInstanceCommandResult> {
  const [command, ...args] = params.args;
  if (!command) {
    throw new Error("missing command");
  }
  const stdout = createCapturedOutputBuffers();
  const maxStdoutBytes = resolveMaxOutputBytes(undefined, "stdout");
  const outputLimit = new AbortController();
  const readStdout = () => finalizeCapturedOutput(stdout, "head", true).toString("utf8");
  const stdoutDiagnostic = createBoundedStringLog();
  const stdoutDiagnosticDecoder = new StringDecoder("utf8");
  const stderr = createBoundedStringLog();
  let child!: ChildProcess;
  try {
    await runManagedCommand({
      bin: command,
      args,
      cwd: params.cwd,
      // The fixture environment is complete; never merge credentials from the parent.
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      timeoutMs: params.timeoutMs,
      timeoutKillGraceMs: 0,
      signal: params.signal
        ? AbortSignal.any([params.signal, outputLimit.signal])
        : outputLimit.signal,
      abortKillGraceMs: 0,
      onReady: (process) => {
        child = process;
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
          appendCapturedOutput(stdout, chunk, maxStdoutBytes, "head");
          appendLogChunk(stdoutDiagnostic, stdoutDiagnosticDecoder.write(chunk));
          if (stdout.truncatedBytes > 0) {
            outputLimit.abort();
          }
        });
        child.stderr?.on("data", (chunk) => appendLogChunk(stderr, chunk));
      },
    });
  } catch (error) {
    appendLogChunk(stdoutDiagnostic, stdoutDiagnosticDecoder.end());
    const message = hasErrnoCode(error, "ETIMEDOUT")
      ? `command timed out after ${params.timeoutMs}ms: ${params.args.join(" ")}`
      : stdout.truncatedBytes > 0
        ? "command stdout exceeded capture limit"
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`${message}\n${formatLogs(stdoutDiagnostic, stderr)}`, { cause: error });
  }
  return {
    code: child.exitCode,
    signal: child.signalCode,
    stdout: readStdout(),
    stderr: readLogBuffer(stderr),
  };
}

function shouldUseOpenClawTestProcessGroup(): boolean {
  return process.platform !== "win32";
}

export const testing = {
  appendLogChunk,
  createBoundedStringLog,
  formatLogs,
  isGatewayMigrationConvergenceRefusal,
  stopGatewayProcess,
  waitForGatewayReady,
};
