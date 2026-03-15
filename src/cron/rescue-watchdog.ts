import net from "node:net";
import { isValidProfileName } from "../cli/profile-utils.js";
import { createConfigIO } from "../config/io.js";
import { resolveGatewayPort } from "../config/paths.js";
import { resolveCurrentCliProgramArguments } from "../daemon/program-args.js";
import { resolveGatewayService } from "../daemon/service.js";
import type { GatewayService } from "../daemon/service.js";
import { resolveGatewayBindHost } from "../gateway/net.js";
import { resolveGatewayProbeAuthSafe } from "../gateway/probe-auth.js";
import { probeGateway } from "../gateway/probe.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  buildRescueProfileEnv,
  canEnableRescueWatchdog,
  resolveMonitoredProfileName,
} from "../rescue/watchdog-shared.js";
import type { CronJob, CronRunOutcome, CronRunTelemetry } from "./types.js";

const PROBE_TIMEOUT_MS = 1_500;
const PROBE_POLL_MS = 500;
const RECOVERY_WAIT_DEADLINE_MS = 30_000;
const DOCTOR_REPAIR_TIMEOUT_MS = 60_000;
const MIN_DOCTOR_TIMEOUT_MS = 1_000;
const RESTART_TIMEOUT_MS = 15_000;
const MIN_RESTART_TIMEOUT_MS = 500;

function looksLikeAuthClose(code: number | undefined, reason: string | undefined): boolean {
  if (code !== 1008) {
    return false;
  }
  const normalized = (reason ?? "").toLowerCase();
  return (
    normalized.includes("auth") ||
    normalized.includes("token") ||
    normalized.includes("password") ||
    normalized.includes("scope") ||
    normalized.includes("role")
  );
}

function summarizeProbeFailure(result: Awaited<ReturnType<typeof probeGateway>>): string {
  if (result.error?.trim()) {
    return result.error.trim();
  }
  if (result.close) {
    const reason = result.close.reason?.trim();
    return reason ? `close ${result.close.code}: ${reason}` : `close ${result.close.code}`;
  }
  return "unreachable";
}

function summarizeCommandFailure(
  result: Awaited<ReturnType<typeof runCommandWithTimeout>>,
): string {
  const output = [result.stderr.trim(), result.stdout.trim()].find(Boolean);
  if (output) {
    return output;
  }
  if (result.termination === "timeout" || result.termination === "no-output-timeout") {
    return "command timed out";
  }
  if (result.signal) {
    return `terminated by ${result.signal}`;
  }
  return `exit code ${result.code ?? "unknown"}`;
}

function formatGatewayProbeHost(host: string): string {
  return net.isIP(host) === 6 && !host.startsWith("[") ? `[${host}]` : host;
}

function resolveProbeHostForBindAddress(bindHost: string): string {
  if (bindHost === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (bindHost === "::") {
    return "::1";
  }
  return bindHost;
}

function parsePortFromProgramArguments(programArguments: string[] | undefined): number | undefined {
  if (!programArguments?.length) {
    return undefined;
  }
  for (let i = 0; i < programArguments.length; i += 1) {
    const arg = programArguments[i]?.trim();
    if (arg === "--port") {
      const next = Number.parseInt(programArguments[i + 1] ?? "", 10);
      if (Number.isFinite(next) && next > 0) {
        return next;
      }
      continue;
    }
    if (!arg?.startsWith("--port=")) {
      continue;
    }
    const inline = Number.parseInt(arg.split("=", 2)[1] ?? "", 10);
    if (Number.isFinite(inline) && inline > 0) {
      return inline;
    }
  }
  return undefined;
}

async function resolveManagedGatewayProbePort(params: {
  cfg: {
    gateway?: {
      port?: number;
    };
  };
  env: NodeJS.ProcessEnv;
  service: GatewayService;
}): Promise<number> {
  // Cross-profile watchdog env intentionally strips service identity overrides,
  // so recover the live managed port from the installed service definition first.
  const command = await params.service.readCommand(params.env).catch(() => null);
  const portFromArgs = parsePortFromProgramArguments(command?.programArguments);
  if (portFromArgs) {
    return portFromArgs;
  }
  const mergedEnv = command?.environment ? { ...params.env, ...command.environment } : params.env;
  return resolveGatewayPort(params.cfg, mergedEnv);
}

async function resolveProfileGatewayProbeUrl(
  cfg: {
    gateway?: {
      bind?: import("../config/config.js").GatewayBindMode;
      customBindHost?: string;
      tls?: { enabled?: boolean };
    };
  },
  port: number,
): Promise<string> {
  const scheme = cfg.gateway?.tls?.enabled === true ? "wss" : "ws";
  const bindMode = cfg.gateway?.bind;
  const customBindHost = cfg.gateway?.customBindHost?.trim();
  const bindHost = await resolveGatewayBindHost(bindMode, customBindHost);
  const host = resolveProbeHostForBindAddress(bindHost);
  return `${scheme}://${formatGatewayProbeHost(host)}:${port}`;
}

async function probeProfileGateway(params: {
  cfg: {
    gateway?: {
      bind?: import("../config/config.js").GatewayBindMode;
      customBindHost?: string;
      tls?: { enabled?: boolean };
    };
  };
  port: number;
  auth: { token?: string; password?: string };
  timeoutMs?: number;
}): Promise<{ healthy: boolean; detail?: string }> {
  const url = await resolveProfileGatewayProbeUrl(params.cfg, params.port);
  const hasSharedProbeAuth = Boolean(params.auth.token || params.auth.password);
  const probe = await probeGateway({
    url,
    auth: hasSharedProbeAuth
      ? { token: params.auth.token, password: params.auth.password }
      : undefined,
    timeoutMs:
      typeof params.timeoutMs === "number"
        ? Math.max(1, Math.min(PROBE_TIMEOUT_MS, params.timeoutMs))
        : PROBE_TIMEOUT_MS,
    // Shared-secret probes do not need pairing, so keep them device-less to
    // avoid remote/tailnet watchdog probes tripping pairing-required closes.
    ...(hasSharedProbeAuth ? { disableDeviceIdentity: true } : {}),
  });
  if (probe.ok || looksLikeAuthClose(probe.close?.code, probe.close?.reason)) {
    return { healthy: true };
  }
  return { healthy: false, detail: summarizeProbeFailure(probe) };
}

async function waitForProfileGateway(params: {
  cfg: {
    gateway?: {
      bind?: import("../config/config.js").GatewayBindMode;
      customBindHost?: string;
      tls?: { enabled?: boolean };
    };
  };
  port: number;
  auth: { token?: string; password?: string };
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ healthy: boolean; detail?: string }> {
  const timeoutMs =
    typeof params.timeoutMs === "number"
      ? Math.max(0, params.timeoutMs)
      : RECOVERY_WAIT_DEADLINE_MS;
  if (timeoutMs <= 0) {
    return { healthy: false, detail: "probe skipped because cron timeout budget was exhausted" };
  }
  const deadlineAt = Date.now() + timeoutMs;
  let lastDetail: string | undefined;
  while (Date.now() < deadlineAt) {
    if (params.abortSignal?.aborted) {
      return { healthy: false, detail: "aborted" };
    }
    const remainingProbeBudgetMs = deadlineAt - Date.now();
    if (remainingProbeBudgetMs <= 0) {
      break;
    }
    const probe = await probeProfileGateway({
      ...params,
      timeoutMs: remainingProbeBudgetMs,
    });
    if (probe.healthy) {
      return probe;
    }
    lastDetail = probe.detail;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        params.abortSignal?.removeEventListener("abort", onAbort);
        resolve();
      }, PROBE_POLL_MS);
      const onAbort = () => {
        clearTimeout(timer);
        params.abortSignal?.removeEventListener("abort", onAbort);
        resolve();
      };
      params.abortSignal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  return { healthy: false, detail: lastDetail ?? "unreachable after restart" };
}

function buildSummary(monitoredProfile: string, actions: string[]): string {
  if (actions.length === 0) {
    return `Rescue watchdog checked "${monitoredProfile}" and found it healthy.`;
  }
  return `Rescue watchdog repaired "${monitoredProfile}": ${actions.join(", ")}.`;
}

function resolveRemainingJobBudgetMs(params: {
  startedAtMs: number;
  payload: CronJob["payload"];
}): number | undefined {
  if (
    params.payload.kind !== "rescueWatchdog" ||
    typeof params.payload.timeoutSeconds !== "number" ||
    params.payload.timeoutSeconds <= 0
  ) {
    return undefined;
  }
  return Math.max(
    0,
    Math.floor(params.payload.timeoutSeconds * 1_000) - (Date.now() - params.startedAtMs),
  );
}

type RunBoundedResult = { ok: true } | { ok: false; error: string; aborted: boolean };

async function runBoundedStep(params: {
  run: (signal: AbortSignal) => Promise<void>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  label: string;
}): Promise<RunBoundedResult> {
  if (params.abortSignal?.aborted) {
    return { ok: false, error: `${params.label} aborted`, aborted: true };
  }
  // Internal controller so we can kill child processes on timeout/abort.
  const stepController = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const runPromise = params.run(stepController.signal).then(
      () => ({ kind: "done" as const }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), params.timeoutMs);
    });
    const abortPromise = new Promise<{ kind: "aborted" }>((resolve) => {
      if (!params.abortSignal) {
        return;
      }
      onAbort = () => resolve({ kind: "aborted" });
      params.abortSignal.addEventListener("abort", onAbort, { once: true });
    });

    const outcome = await Promise.race([runPromise, timeoutPromise, abortPromise]);
    if (outcome.kind === "done") {
      return { ok: true };
    }
    // On timeout or abort, cancel in-flight child processes.
    stepController.abort();
    if (outcome.kind === "error") {
      return {
        ok: false,
        error: outcome.error instanceof Error ? outcome.error.message : `${params.label} failed`,
        aborted: false,
      };
    }
    if (outcome.kind === "aborted") {
      return { ok: false, error: `${params.label} aborted`, aborted: true };
    }
    return {
      ok: false,
      error: `${params.label} timed out after ${params.timeoutMs}ms`,
      aborted: false,
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (params.abortSignal && onAbort) {
      params.abortSignal.removeEventListener("abort", onAbort);
    }
  }
}

export async function runRescueWatchdogJob(params: {
  job: CronJob;
  monitoredProfile: string;
  abortSignal?: AbortSignal;
}): Promise<CronRunOutcome & CronRunTelemetry> {
  const startedAtMs = Date.now();
  const monitoredProfile = resolveMonitoredProfileName(params.monitoredProfile);
  if (monitoredProfile !== "default" && !isValidProfileName(monitoredProfile)) {
    return {
      status: "error",
      error: `invalid monitored profile "${monitoredProfile}"`,
    };
  }
  if (!canEnableRescueWatchdog(monitoredProfile)) {
    return {
      status: "error",
      error: `invalid monitored profile "${monitoredProfile}": rescue watchdog cannot monitor rescue profiles`,
    };
  }

  const env = buildRescueProfileEnv(monitoredProfile);
  let cfg;
  try {
    cfg = createConfigIO({ env }).loadConfig();
  } catch (error) {
    return {
      status: "error",
      error: `failed to load monitored profile config: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const { auth, warning } = resolveGatewayProbeAuthSafe({
    cfg,
    mode: "local",
    env,
  });
  let service;
  try {
    service = resolveGatewayService();
  } catch (error) {
    return {
      status: "error",
      error: `gateway service control unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const port = await resolveManagedGatewayProbePort({ cfg, env, service });
  const actions: string[] = [];

  const initialProbe = await probeProfileGateway({ cfg, port, auth });
  if (initialProbe.healthy) {
    return {
      status: "ok",
      summary: buildSummary(monitoredProfile, actions),
    };
  }

  let restartError: string | undefined;
  const remainingBeforeRestartMs = resolveRemainingJobBudgetMs({
    startedAtMs,
    payload: params.job.payload,
  });
  if (
    typeof remainingBeforeRestartMs === "number" &&
    remainingBeforeRestartMs < MIN_RESTART_TIMEOUT_MS
  ) {
    restartError = `skipped restart because only ${remainingBeforeRestartMs}ms remained in the cron job budget`;
  } else {
    const restartTimeoutMs =
      typeof remainingBeforeRestartMs === "number"
        ? Math.min(RESTART_TIMEOUT_MS, remainingBeforeRestartMs)
        : RESTART_TIMEOUT_MS;
    const restartResult = await runBoundedStep({
      run: async (signal) => {
        await service.restart({ env, stdout: process.stdout, signal });
      },
      timeoutMs: restartTimeoutMs,
      abortSignal: params.abortSignal,
      label: "service restart",
    });
    if (restartResult.ok) {
      actions.push("restarted managed gateway service");
    } else {
      restartError = restartResult.error;
      if (restartResult.aborted) {
        return {
          status: "error",
          error: restartResult.error,
          summary: actions.length > 0 ? buildSummary(monitoredProfile, actions) : undefined,
        };
      }
    }
  }

  const restartProbe = await waitForProfileGateway({
    cfg,
    port,
    auth,
    abortSignal: params.abortSignal,
    timeoutMs: (() => {
      const remaining = resolveRemainingJobBudgetMs({
        startedAtMs,
        payload: params.job.payload,
      });
      return typeof remaining === "number"
        ? Math.min(RECOVERY_WAIT_DEADLINE_MS, remaining)
        : undefined;
    })(),
  });
  if (restartProbe.healthy) {
    return {
      status: "ok",
      summary: buildSummary(monitoredProfile, actions),
    };
  }

  const remainingJobBudgetMs = resolveRemainingJobBudgetMs({
    startedAtMs,
    payload: params.job.payload,
  });
  if (typeof remainingJobBudgetMs === "number" && remainingJobBudgetMs < MIN_DOCTOR_TIMEOUT_MS) {
    const errors = [
      warning,
      restartError ? `restart failed: ${restartError}` : undefined,
      `skipped doctor fallback because only ${remainingJobBudgetMs}ms remained in the cron job budget`,
      `probe failed: ${restartProbe.detail ?? initialProbe.detail ?? "unreachable"}`,
    ].filter(Boolean);
    return {
      status: "error",
      error: errors.join(" | "),
      summary: actions.length > 0 ? buildSummary(monitoredProfile, actions) : undefined,
    };
  }

  if (params.abortSignal?.aborted) {
    const errors = [
      warning,
      restartError ? `restart failed: ${restartError}` : undefined,
      "doctor fallback aborted",
      `probe failed: ${restartProbe.detail ?? initialProbe.detail ?? "unreachable"}`,
    ].filter(Boolean);
    return {
      status: "error",
      error: errors.join(" | "),
      summary: actions.length > 0 ? buildSummary(monitoredProfile, actions) : undefined,
    };
  }

  // Keep the repair fallback deterministic: exact argv, no shell, no agent prompt.
  // Use the same runtime + entrypoint as the current process so the binary is
  // resolved without relying on PATH (managed service environments often run
  // with a minimized PATH that omits the CLI binary).
  const doctorArgs = ["--profile", monitoredProfile, "doctor", "--repair", "--non-interactive"];
  const doctorArgv = await resolveCurrentCliProgramArguments(doctorArgs);
  const doctorResult = await runCommandWithTimeout(doctorArgv, {
    timeoutMs:
      typeof remainingJobBudgetMs === "number"
        ? Math.min(DOCTOR_REPAIR_TIMEOUT_MS, remainingJobBudgetMs)
        : DOCTOR_REPAIR_TIMEOUT_MS,
    baseEnv: {},
    env,
    signal: params.abortSignal,
  });
  if (doctorResult.code === 0) {
    actions.push("ran doctor --repair --non-interactive");
  }

  const doctorProbe = await waitForProfileGateway({
    cfg,
    port,
    auth,
    abortSignal: params.abortSignal,
    timeoutMs: (() => {
      const remaining = resolveRemainingJobBudgetMs({
        startedAtMs,
        payload: params.job.payload,
      });
      return typeof remaining === "number"
        ? Math.min(RECOVERY_WAIT_DEADLINE_MS, remaining)
        : undefined;
    })(),
  });
  if (doctorProbe.healthy) {
    return {
      status: "ok",
      summary: buildSummary(monitoredProfile, actions),
    };
  }

  const errors = [
    warning,
    restartError ? `restart failed: ${restartError}` : undefined,
    doctorResult.code === 0 ? undefined : `doctor failed: ${summarizeCommandFailure(doctorResult)}`,
    `probe failed: ${doctorProbe.detail ?? restartProbe.detail ?? initialProbe.detail ?? "unreachable"}`,
  ].filter(Boolean);

  return {
    status: "error",
    error: errors.join(" | "),
    summary: actions.length > 0 ? buildSummary(monitoredProfile, actions) : undefined,
  };
}
