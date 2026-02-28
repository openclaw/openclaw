import { spawnSync } from "node:child_process";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
} from "../daemon/constants.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { cleanStaleGatewayProcessesSync, findGatewayPidsOnPortSync } from "./restart-stale-pids.js";

export type RestartAttempt = {
  ok: boolean;
  method: "launchctl" | "systemd" | "supervisor";
  detail?: string;
  tried?: string[];
};

const SPAWN_TIMEOUT_MS = 2000;
const SIGUSR1_AUTH_GRACE_MS = 5000;
const DEFAULT_DEFERRAL_POLL_MS = 500;
const DEFAULT_DEFERRAL_MAX_WAIT_MS = 30_000;
const RESTART_COOLDOWN_MS = 30_000;

const restartLog = createSubsystemLogger("restart");

export { findGatewayPidsOnPortSync };

let sigusr1AuthorizedCount = 0;
let sigusr1AuthorizedUntil = 0;
let sigusr1ExternalAllowed = false;
let preRestartCheck: (() => number) | null = null;
let restartCycleToken = 0;
let emittedRestartToken = 0;
let consumedRestartToken = 0;
let lastRestartEmittedAt = 0;
let pendingRestartTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRestartDueAt = 0;
let pendingRestartReason: string | undefined;

function hasUnconsumedRestartSignal(): boolean {
  return emittedRestartToken > consumedRestartToken;
}

function clearPendingScheduledRestart(): void {
  if (pendingRestartTimer) {
    clearTimeout(pendingRestartTimer);
  }
  pendingRestartTimer = null;
  pendingRestartDueAt = 0;
  pendingRestartReason = undefined;
}

export type RestartAuditInfo = {
  actor?: string;
  deviceId?: string;
  clientIp?: string;
  changedPaths?: string[];
};

function summarizeChangedPaths(paths: string[] | undefined, maxPaths = 6): string | null {
  if (!Array.isArray(paths) || paths.length === 0) {
    return null;
  }
  if (paths.length <= maxPaths) {
    return paths.join(",");
  }
  const head = paths.slice(0, maxPaths).join(",");
  return `${head},+${paths.length - maxPaths} more`;
}

function formatRestartAudit(audit: RestartAuditInfo | undefined): string {
  const actor = typeof audit?.actor === "string" && audit.actor.trim() ? audit.actor.trim() : null;
  const deviceId =
    typeof audit?.deviceId === "string" && audit.deviceId.trim() ? audit.deviceId.trim() : null;
  const clientIp =
    typeof audit?.clientIp === "string" && audit.clientIp.trim() ? audit.clientIp.trim() : null;
  const changed = summarizeChangedPaths(audit?.changedPaths);
  const fields = [];
  if (actor) {
    fields.push(`actor=${actor}`);
  }
  if (deviceId) {
    fields.push(`device=${deviceId}`);
  }
  if (clientIp) {
    fields.push(`ip=${clientIp}`);
  }
  if (changed) {
    fields.push(`changedPaths=${changed}`);
  }
  return fields.length > 0 ? fields.join(" ") : "actor=<unknown>";
}

/**
 * Register a callback that scheduleGatewaySigusr1Restart checks before emitting SIGUSR1.
 * The callback should return the number of pending items (0 = safe to restart).
 */
export function setPreRestartDeferralCheck(fn: () => number): void {
  preRestartCheck = fn;
}

/**
 * Emit an authorized SIGUSR1 gateway restart, guarded against duplicate emissions.
 * Returns true if SIGUSR1 was emitted, false if a restart was already emitted.
 * Both scheduleGatewaySigusr1Restart and the config watcher should use this
 * to ensure only one restart fires.
 */
export function emitGatewayRestart(): boolean {
  if (hasUnconsumedRestartSignal()) {
    clearPendingScheduledRestart();
    return false;
  }
  clearPendingScheduledRestart();
  const cycleToken = ++restartCycleToken;
  emittedRestartToken = cycleToken;
  authorizeGatewaySigusr1Restart();
  try {
    if (process.listenerCount("SIGUSR1") > 0) {
      process.emit("SIGUSR1");
    } else {
      process.kill(process.pid, "SIGUSR1");
    }
  } catch {
    // Roll back the cycle marker so future restart requests can still proceed.
    emittedRestartToken = consumedRestartToken;
    return false;
  }
  lastRestartEmittedAt = Date.now();
  return true;
}

function resetSigusr1AuthorizationIfExpired(now = Date.now()) {
  if (sigusr1AuthorizedCount <= 0) {
    return;
  }
  if (now <= sigusr1AuthorizedUntil) {
    return;
  }
  sigusr1AuthorizedCount = 0;
  sigusr1AuthorizedUntil = 0;
}

export function setGatewaySigusr1RestartPolicy(opts?: { allowExternal?: boolean }) {
  sigusr1ExternalAllowed = opts?.allowExternal === true;
}

export function isGatewaySigusr1RestartExternallyAllowed() {
  return sigusr1ExternalAllowed;
}

function authorizeGatewaySigusr1Restart(delayMs = 0) {
  const delay = Math.max(0, Math.floor(delayMs));
  const expiresAt = Date.now() + delay + SIGUSR1_AUTH_GRACE_MS;
  sigusr1AuthorizedCount += 1;
  if (expiresAt > sigusr1AuthorizedUntil) {
    sigusr1AuthorizedUntil = expiresAt;
  }
}

export function consumeGatewaySigusr1RestartAuthorization(): boolean {
  resetSigusr1AuthorizationIfExpired();
  if (sigusr1AuthorizedCount <= 0) {
    return false;
  }
  sigusr1AuthorizedCount -= 1;
  if (sigusr1AuthorizedCount <= 0) {
    sigusr1AuthorizedUntil = 0;
  }
  return true;
}

/**
 * Mark the currently emitted SIGUSR1 restart cycle as consumed by the run loop.
 * This explicitly advances the cycle state instead of resetting emit guards inside
 * consumeGatewaySigusr1RestartAuthorization().
 */
export function markGatewaySigusr1RestartHandled(): void {
  if (hasUnconsumedRestartSignal()) {
    consumedRestartToken = emittedRestartToken;
  }
}

export type RestartDeferralHooks = {
  onDeferring?: (pending: number) => void;
  onReady?: () => void;
  onTimeout?: (pending: number, elapsedMs: number) => void;
  onCheckError?: (err: unknown) => void;
};

/**
 * Poll pending work until it drains (or times out), then emit one restart signal.
 * Shared by both the direct RPC restart path and the config watcher path.
 */
export function deferGatewayRestartUntilIdle(opts: {
  getPendingCount: () => number;
  hooks?: RestartDeferralHooks;
  pollMs?: number;
  maxWaitMs?: number;
}): void {
  const pollMsRaw = opts.pollMs ?? DEFAULT_DEFERRAL_POLL_MS;
  const pollMs = Math.max(10, Math.floor(pollMsRaw));
  const maxWaitMsRaw = opts.maxWaitMs ?? DEFAULT_DEFERRAL_MAX_WAIT_MS;
  const maxWaitMs = Math.max(pollMs, Math.floor(maxWaitMsRaw));

  let pending: number;
  try {
    pending = opts.getPendingCount();
  } catch (err) {
    opts.hooks?.onCheckError?.(err);
    emitGatewayRestart();
    return;
  }
  if (pending <= 0) {
    opts.hooks?.onReady?.();
    emitGatewayRestart();
    return;
  }

  opts.hooks?.onDeferring?.(pending);
  const startedAt = Date.now();
  const poll = setInterval(() => {
    let current: number;
    try {
      current = opts.getPendingCount();
    } catch (err) {
      clearInterval(poll);
      opts.hooks?.onCheckError?.(err);
      emitGatewayRestart();
      return;
    }
    if (current <= 0) {
      clearInterval(poll);
      opts.hooks?.onReady?.();
      emitGatewayRestart();
      return;
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= maxWaitMs) {
      clearInterval(poll);
      opts.hooks?.onTimeout?.(current, elapsedMs);
      emitGatewayRestart();
    }
  }, pollMs);
}

function formatSpawnDetail(result: {
  error?: unknown;
  status?: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
}): string {
  const clean = (value: string | Buffer | null | undefined) => {
    const text = typeof value === "string" ? value : value ? value.toString() : "";
    return text.replace(/\s+/g, " ").trim();
  };
  if (result.error) {
    if (result.error instanceof Error) {
      return result.error.message;
    }
    if (typeof result.error === "string") {
      return result.error;
    }
    try {
      return JSON.stringify(result.error);
    } catch {
      return "unknown error";
    }
  }
  const stderr = clean(result.stderr);
  if (stderr) {
    return stderr;
  }
  const stdout = clean(result.stdout);
  if (stdout) {
    return stdout;
  }
  if (typeof result.status === "number") {
    return `exit ${result.status}`;
  }
  return "unknown error";
}

function normalizeSystemdUnit(raw?: string, profile?: string): string {
  const unit = raw?.trim();
  if (!unit) {
    return `${resolveGatewaySystemdServiceName(profile)}.service`;
  }
  return unit.endsWith(".service") ? unit : `${unit}.service`;
}

export function triggerOpenClawRestart(): RestartAttempt {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return { ok: true, method: "supervisor", detail: "test mode" };
  }

  cleanStaleGatewayProcessesSync();

  const tried: string[] = [];
  if (process.platform !== "darwin") {
    if (process.platform === "linux") {
      const unit = normalizeSystemdUnit(
        process.env.OPENCLAW_SYSTEMD_UNIT,
        process.env.OPENCLAW_PROFILE,
      );
      const userArgs = ["--user", "restart", unit];
      tried.push(`systemctl ${userArgs.join(" ")}`);
      const userRestart = spawnSync("systemctl", userArgs, {
        encoding: "utf8",
        timeout: SPAWN_TIMEOUT_MS,
      });
      if (!userRestart.error && userRestart.status === 0) {
        return { ok: true, method: "systemd", tried };
      }
      const systemArgs = ["restart", unit];
      tried.push(`systemctl ${systemArgs.join(" ")}`);
      const systemRestart = spawnSync("systemctl", systemArgs, {
        encoding: "utf8",
        timeout: SPAWN_TIMEOUT_MS,
      });
      if (!systemRestart.error && systemRestart.status === 0) {
        return { ok: true, method: "systemd", tried };
      }
      const detail = [
        `user: ${formatSpawnDetail(userRestart)}`,
        `system: ${formatSpawnDetail(systemRestart)}`,
      ].join("; ");
      return { ok: false, method: "systemd", detail, tried };
    }
    return {
      ok: false,
      method: "supervisor",
      detail: "unsupported platform restart",
    };
  }

  const label =
    process.env.OPENCLAW_LAUNCHD_LABEL ||
    resolveGatewayLaunchAgentLabel(process.env.OPENCLAW_PROFILE);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const target = uid !== undefined ? `gui/${uid}/${label}` : label;
  const args = ["kickstart", "-k", target];
  tried.push(`launchctl ${args.join(" ")}`);
  const res = spawnSync("launchctl", args, {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  if (!res.error && res.status === 0) {
    return { ok: true, method: "launchctl", tried };
  }
  return {
    ok: false,
    method: "launchctl",
    detail: formatSpawnDetail(res),
    tried,
  };
}

export type ScheduledRestart = {
  ok: boolean;
  pid: number;
  signal: "SIGUSR1";
  delayMs: number;
  reason?: string;
  mode: "emit" | "signal";
  coalesced: boolean;
  cooldownMsApplied: number;
};

export function scheduleGatewaySigusr1Restart(opts?: {
  delayMs?: number;
  reason?: string;
  audit?: RestartAuditInfo;
}): ScheduledRestart {
  const delayMsRaw =
    typeof opts?.delayMs === "number" && Number.isFinite(opts.delayMs)
      ? Math.floor(opts.delayMs)
      : 2000;
  const delayMs = Math.min(Math.max(delayMsRaw, 0), 60_000);
  const reason =
    typeof opts?.reason === "string" && opts.reason.trim()
      ? opts.reason.trim().slice(0, 200)
      : undefined;
  const mode = process.listenerCount("SIGUSR1") > 0 ? "emit" : "signal";
  const nowMs = Date.now();
  const cooldownMsApplied = Math.max(0, lastRestartEmittedAt + RESTART_COOLDOWN_MS - nowMs);
  const requestedDueAt = nowMs + delayMs + cooldownMsApplied;

  if (hasUnconsumedRestartSignal()) {
    restartLog.warn(
      `restart request coalesced (already in-flight) reason=${reason ?? "unspecified"} ${formatRestartAudit(opts?.audit)}`,
    );
    return {
      ok: true,
      pid: process.pid,
      signal: "SIGUSR1",
      delayMs: 0,
      reason,
      mode,
      coalesced: true,
      cooldownMsApplied,
    };
  }

  if (pendingRestartTimer) {
    const remainingMs = Math.max(0, pendingRestartDueAt - nowMs);
    const shouldPullEarlier = requestedDueAt < pendingRestartDueAt;
    if (shouldPullEarlier) {
      restartLog.warn(
        `restart request rescheduled earlier reason=${reason ?? "unspecified"} pendingReason=${pendingRestartReason ?? "unspecified"} oldDelayMs=${remainingMs} newDelayMs=${Math.max(0, requestedDueAt - nowMs)} ${formatRestartAudit(opts?.audit)}`,
      );
      clearPendingScheduledRestart();
    } else {
      restartLog.warn(
        `restart request coalesced (already scheduled) reason=${reason ?? "unspecified"} pendingReason=${pendingRestartReason ?? "unspecified"} delayMs=${remainingMs} ${formatRestartAudit(opts?.audit)}`,
      );
      return {
        ok: true,
        pid: process.pid,
        signal: "SIGUSR1",
        delayMs: remainingMs,
        reason,
        mode,
        coalesced: true,
        cooldownMsApplied,
      };
    }
  }

  pendingRestartDueAt = requestedDueAt;
  pendingRestartReason = reason;
  pendingRestartTimer = setTimeout(
    () => {
      pendingRestartTimer = null;
      pendingRestartDueAt = 0;
      pendingRestartReason = undefined;
      const pendingCheck = preRestartCheck;
      if (!pendingCheck) {
        emitGatewayRestart();
        return;
      }
      deferGatewayRestartUntilIdle({ getPendingCount: pendingCheck });
    },
    Math.max(0, requestedDueAt - nowMs),
  );
  return {
    ok: true,
    pid: process.pid,
    signal: "SIGUSR1",
    delayMs: Math.max(0, requestedDueAt - nowMs),
    reason,
    mode,
    coalesced: false,
    cooldownMsApplied,
  };
}

export const __testing = {
  resetSigusr1State() {
    sigusr1AuthorizedCount = 0;
    sigusr1AuthorizedUntil = 0;
    sigusr1ExternalAllowed = false;
    preRestartCheck = null;
    restartCycleToken = 0;
    emittedRestartToken = 0;
    consumedRestartToken = 0;
    lastRestartEmittedAt = 0;
    clearPendingScheduledRestart();
  },
};
