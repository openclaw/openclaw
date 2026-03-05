import { execFile } from "node:child_process";
import fs from "node:fs";

const SYSTEMD_NOTIFY_CANDIDATES = ["/usr/bin/systemd-notify", "/bin/systemd-notify"];
let resolvedSystemdNotifyPath: string | null | undefined;
let warnedSystemdNotifyMissing = false;

function warnNotify(message: string, error: Error): void {
  try {
    process.stderr.write(`sd-notify: ${message}: ${error.message}\n`);
  } catch {
    // stderr may be closed (EPIPE) when the service runs with stdio detached.
  }
}

function resolveSystemdNotifyPath(): string | undefined {
  if (resolvedSystemdNotifyPath !== undefined) {
    return resolvedSystemdNotifyPath ?? undefined;
  }
  for (const candidate of SYSTEMD_NOTIFY_CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      resolvedSystemdNotifyPath = candidate;
      return candidate;
    } catch {
      // Try next candidate.
    }
  }
  resolvedSystemdNotifyPath = null;
  if (!warnedSystemdNotifyMissing) {
    warnedSystemdNotifyMissing = true;
    try {
      process.stderr.write(
        `sd-notify: could not find systemd-notify in ${SYSTEMD_NOTIFY_CANDIDATES.join(", ")}\n`,
      );
    } catch {
      // stderr may be closed (EPIPE) when the service runs with stdio detached.
    }
  }
  return undefined;
}

function execSystemdNotify(args: string[], onDone: (error: Error | null) => void): boolean {
  const binary = resolveSystemdNotifyPath();
  if (!binary) {
    return false;
  }
  execFile(binary, args, { timeout: 5000 }, (error) => {
    onDone(error ?? null);
  });
  return true;
}

/**
 * Send sd_notify READY=1 to systemd, signalling the service is fully started.
 * No-op when not running under a systemd Type=notify unit.
 */
export function sdNotifyReady(): void {
  if (!process.env.NOTIFY_SOCKET) {
    return;
  }
  execSystemdNotify(["--ready"], (error) => {
    if (!error) {
      return;
    }
    warnNotify("failed to send READY=1 — systemd will kill this unit after TimeoutStartSec", error);
  });
}

/**
 * Reset systemd's remaining startup timeout to the given number of seconds
 * from now (EXTEND_TIMEOUT_USEC). This is not additive — it replaces the
 * current remaining deadline. Useful before long-running initialization
 * steps (e.g. asset builds) that may exceed the default TimeoutStartSec
 * before READY=1 is sent.
 * No-op when not running under a systemd Type=notify unit.
 */
export function sdNotifyExtendTimeout(seconds: number): void {
  if (!process.env.NOTIFY_SOCKET) {
    return;
  }
  const usec = Math.max(0, Math.round(seconds * 1_000_000));
  execSystemdNotify([`EXTEND_TIMEOUT_USEC=${usec}`], (error) => {
    if (!error) {
      return;
    }
    warnNotify("failed to extend startup timeout", error);
  });
}

let watchdogWarnedOnce = false;
let watchdogInFlight = false;

/** Reset watchdog warning state. Exported for testing only. */
export function _resetWatchdogWarned(): void {
  watchdogWarnedOnce = false;
  watchdogInFlight = false;
}

/**
 * Send sd_notify WATCHDOG=1 heartbeat to systemd.
 * No-op when not running under a systemd WatchdogSec unit.
 * Skips if a previous heartbeat call is still in flight to prevent
 * overlapping `execFile()` calls from piling up under resource pressure.
 */
export function sdNotifyWatchdog(): void {
  if (!process.env.NOTIFY_SOCKET) {
    return;
  }
  if (watchdogInFlight) {
    return;
  }
  watchdogInFlight = true;
  if (
    !execSystemdNotify(["WATCHDOG=1"], (error) => {
      watchdogInFlight = false;
      if (error && !watchdogWarnedOnce) {
        watchdogWarnedOnce = true;
        warnNotify(
          "failed to send WATCHDOG=1 — systemd will restart this unit after WatchdogSec",
          error,
        );
      }
    })
  ) {
    watchdogInFlight = false;
  }
}

/**
 * Start the watchdog heartbeat loop, deriving the interval from systemd's
 * WATCHDOG_USEC env var (standard sd_watchdog_enabled(3) pattern).
 * Sends WATCHDOG=1 at half the configured WatchdogSec so the cadence
 * automatically tracks the unit file without hardcoded coupling.
 * No-op when WATCHDOG_USEC or NOTIFY_SOCKET is unset.
 * Returns a cleanup function to stop the timer.
 */
export function startWatchdogHeartbeat(): (() => void) | undefined {
  if (!process.env.NOTIFY_SOCKET) {
    return undefined;
  }
  const usecRaw = process.env.WATCHDOG_USEC;
  if (!usecRaw) {
    return undefined;
  }
  const usec = Number.parseInt(usecRaw, 10);
  if (!Number.isFinite(usec) || usec <= 0) {
    return undefined;
  }
  const intervalMs = Math.floor(usec / 1000 / 2);
  if (intervalMs <= 0) {
    return undefined;
  }
  const timer = setInterval(() => sdNotifyWatchdog(), intervalMs);
  timer.unref();
  sdNotifyWatchdog();
  return () => clearInterval(timer);
}

/** @internal Reset notify command resolution cache. Exported for testing only. */
export function _resetSystemdNotifyPathForTests(): void {
  resolvedSystemdNotifyPath = undefined;
  warnedSystemdNotifyMissing = false;
}
