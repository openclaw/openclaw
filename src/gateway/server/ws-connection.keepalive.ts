// Per-connection WebSocket keepalive: ping an idle peer and close it if it does
// not pong within the timeout, so a half-open/dead client socket is recycled in
// ~interval+timeout instead of lingering until the OS TCP timeout (15-30 min).
//
// Scheduling is setTimeout-based, NOT a polling interval: an idle connection
// wakes ~once per `intervalMs` (to ping) plus a single `timeoutMs` deadline
// while awaiting the pong. That keeps timer churn on the single-threaded gateway
// event loop proportional to the ping cadence, not to a sub-interval poll.
import type { WebSocket } from "ws";

export const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000;
// 10s, not 5s: on a saturated single-thread gateway the inbound pong can be
// decoded late, and a too-eager deadline would close a live peer and trigger a
// reconnect/re-auth wave that compounds the stall. 10s tolerates realistic
// event-loop hiccups while still recycling a dead socket in ~interval+timeout.
export const DEFAULT_KEEPALIVE_TIMEOUT_MS = 10_000;

export type KeepAliveConfig = {
  intervalMs: number;
  timeoutMs: number;
};

export type KeepAliveHandle = {
  /** Stop all timers and detach the pong listener. Idempotent; call on close. */
  stop: () => void;
};

/**
 * Resolve the effective keepalive config from `gateway.keepalive`. Keepalive is
 * ON by default; an operator disables it with `gateway.keepalive.interval: 0`.
 * Returns null when disabled. Ranges and `timeout < interval` are enforced by
 * the config schema (see src/config/zod-schema.ts), so values reaching here are
 * already valid.
 */
export function resolveKeepAliveConfig(
  cfg: { interval?: number; timeout?: number } | undefined,
): KeepAliveConfig | null {
  const intervalMs = cfg?.interval ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
  if (intervalMs <= 0) {
    return null;
  }
  return { intervalMs, timeoutMs: cfg?.timeout ?? DEFAULT_KEEPALIVE_TIMEOUT_MS };
}

/**
 * Start keepalive for one post-auth connection. After `intervalMs` with no pong,
 * sends a WS ping; if the peer does not pong within `timeoutMs`, calls
 * `onUnresponsive()` exactly once and stops (the caller owns the actual close,
 * so the close cause/teardown stay in one place). A pong restarts the idle
 * clock. The `ws` library answers inbound pings with pongs automatically, so a
 * healthy peer never trips this.
 */
export function startKeepAlive(
  socket: WebSocket,
  config: KeepAliveConfig,
  onUnresponsive: () => void,
): KeepAliveHandle {
  let pingTimer: ReturnType<typeof setTimeout> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const clearPong = () => {
    if (pongTimer !== undefined) {
      clearTimeout(pongTimer);
      pongTimer = undefined;
    }
  };

  const scheduleNextPing = () => {
    pingTimer = setTimeout(probe, config.intervalMs);
  };

  const probe = () => {
    if (stopped) {
      return;
    }
    try {
      socket.ping();
    } catch {
      // ws.ping() throws only while the socket is CONNECTING; keepalive starts
      // post-handshake so this is not expected. If it ever happens, tear down
      // instead of sitting dormant with the pong listener still attached.
      stop();
      return;
    }
    // Wait for the peer to prove liveness; no pong in time => unresponsive.
    pongTimer = setTimeout(() => {
      if (stopped) {
        return;
      }
      stop();
      onUnresponsive();
    }, config.timeoutMs);
  };

  const onPong = () => {
    if (stopped) {
      return;
    }
    // Peer is alive: cancel any pending deadline and restart the idle clock.
    clearPong();
    if (pingTimer !== undefined) {
      clearTimeout(pingTimer);
    }
    scheduleNextPing();
  };

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (pingTimer !== undefined) {
      clearTimeout(pingTimer);
      pingTimer = undefined;
    }
    clearPong();
    socket.off("pong", onPong);
    socket.off("close", stop);
  };

  // The gateway also calls stop() from its close path; self-registering on
  // "close" guarantees the timers + pong listener are released even if a
  // teardown path bypasses that (terminate(), a raw error). stop() is idempotent.
  socket.on("pong", onPong);
  socket.once("close", stop);
  scheduleNextPing();
  return { stop };
}
