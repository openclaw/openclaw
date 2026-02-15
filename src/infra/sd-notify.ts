import { execFile } from "node:child_process";

function warnNotify(message: string, error: Error): void {
  try {
    process.stderr.write(`sd-notify: ${message}: ${error.message}\n`);
  } catch {
    // stderr may be closed (EPIPE) when the service runs with stdio detached.
  }
}

/**
 * Send sd_notify READY=1 to systemd, signalling the service is fully started.
 * No-op when not running under a systemd Type=notify unit.
 */
export function sdNotifyReady(): void {
  if (!process.env.NOTIFY_SOCKET) {
    return;
  }
  execFile("systemd-notify", ["--ready"], { timeout: 5000 }, (error) => {
    if (error) {
      warnNotify(
        "failed to send READY=1 — systemd will kill this unit after TimeoutStartSec",
        error,
      );
    }
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
  execFile("systemd-notify", [`EXTEND_TIMEOUT_USEC=${usec}`], { timeout: 5000 }, (error) => {
    if (error) {
      warnNotify("failed to extend startup timeout", error);
    }
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
  execFile("systemd-notify", ["WATCHDOG=1"], { timeout: 5000 }, (error) => {
    watchdogInFlight = false;
    if (error && !watchdogWarnedOnce) {
      watchdogWarnedOnce = true;
      warnNotify(
        "failed to send WATCHDOG=1 — systemd will restart this unit after WatchdogSec",
        error,
      );
    }
  });
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
