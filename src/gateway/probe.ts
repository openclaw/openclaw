import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "../infra/errors.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import { READ_SCOPE } from "./method-scopes.js";
import { isLoopbackHost } from "./net.js";

export type GatewayProbeAuth = {
  token?: string;
  password?: string;
};

export type GatewayProbeClose = {
  code: number;
  reason: string;
  hint?: string;
};

export type GatewayProbeResult = {
  ok: boolean;
  url: string;
  connectLatencyMs: number | null;
  error: string | null;
  close: GatewayProbeClose | null;
  health: unknown;
  status: unknown;
  presence: SystemPresence[] | null;
  configSnapshot: unknown;
};

export const MIN_PROBE_TIMEOUT_MS = 250;
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function clampProbeTimeoutMs(timeoutMs: number): number {
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(MIN_PROBE_TIMEOUT_MS, timeoutMs));
}

function formatProbeCloseError(close: GatewayProbeClose): string {
  return `gateway closed (${close.code}): ${close.reason}`;
}

// Device-required rejections happen when the CLI probe connects to a gateway
// that is configured to require device pairing but the calling process has no
// device identity (e.g. `openclaw status` invoked by a short-lived cron session,
// or any script that re-spawns the CLI repeatedly). Each new CLI process starts
// a fresh `GatewayClient` instance which cannot learn from prior rejections, so
// upstream observers see tight bursts of `handshake failed cause=device-required`
// log entries (see #63427 — 1127 rejections in 24h from 73 sessions).
//
// To dampen the log noise without changing the reachability semantics, track
// recent device-required rejections per URL at module scope. Once a URL has
// been rejected `DEVICE_REQUIRED_FAILURE_THRESHOLD` times within
// `DEVICE_REQUIRED_TTL_MS`, subsequent probes for the same URL short-circuit
// with a synthetic rejected result for the rest of the TTL window instead of
// opening another WebSocket. Any successful probe clears the cache entry so a
// newly-paired gateway reverts to normal probing immediately.
const DEVICE_REQUIRED_FAILURE_THRESHOLD = 3;
const DEVICE_REQUIRED_TTL_MS = 5 * 60_000;

type DeviceRequiredCacheEntry = {
  failures: number;
  firstFailureAt: number;
};

const deviceRequiredCache = new Map<string, DeviceRequiredCacheEntry>();

function isDeviceRequiredClose(close: GatewayProbeClose | null): boolean {
  if (!close || close.code !== 1008) {
    return false;
  }
  return close.reason.includes("device identity");
}

function noteDeviceRequiredFailure(url: string, now: number): void {
  const existing = deviceRequiredCache.get(url);
  if (!existing || now - existing.firstFailureAt >= DEVICE_REQUIRED_TTL_MS) {
    deviceRequiredCache.set(url, { failures: 1, firstFailureAt: now });
    return;
  }
  existing.failures += 1;
}

function shouldSkipProbeForDeviceRequired(url: string, now: number): boolean {
  const entry = deviceRequiredCache.get(url);
  if (!entry) {
    return false;
  }
  if (now - entry.firstFailureAt >= DEVICE_REQUIRED_TTL_MS) {
    deviceRequiredCache.delete(url);
    return false;
  }
  return entry.failures >= DEVICE_REQUIRED_FAILURE_THRESHOLD;
}

function clearDeviceRequiredCacheFor(url: string): void {
  deviceRequiredCache.delete(url);
}

/**
 * Test-only helper: reset the module-level device-required cache so tests can
 * run in isolation without carrying state across suites.
 */
export function __resetDeviceRequiredCacheForTests(): void {
  deviceRequiredCache.clear();
}

function makeDeviceRequiredShortCircuitResult(url: string): GatewayProbeResult {
  return {
    ok: false,
    url,
    connectLatencyMs: null,
    error:
      "gateway closed (1008): device identity required (cached short-circuit — retry after pairing)",
    close: {
      code: 1008,
      reason: "device identity required",
      hint: "probe short-circuited by recent device-required rejections",
    },
    health: null,
    status: null,
    presence: null,
    configSnapshot: null,
  };
}

export async function probeGateway(opts: {
  url: string;
  auth?: GatewayProbeAuth;
  timeoutMs: number;
  includeDetails?: boolean;
  detailLevel?: "none" | "presence" | "full";
  tlsFingerprint?: string;
}): Promise<GatewayProbeResult> {
  const startedAt = Date.now();
  // Short-circuit repeated device-required rejections to dampen CLI log noise
  // when many short-lived processes probe the same unpaired gateway in a burst.
  if (shouldSkipProbeForDeviceRequired(opts.url, startedAt)) {
    return makeDeviceRequiredShortCircuitResult(opts.url);
  }
  const instanceId = randomUUID();
  let connectLatencyMs: number | null = null;
  let connectError: string | null = null;
  let close: GatewayProbeClose | null = null;

  const detailLevel = opts.includeDetails === false ? "none" : (opts.detailLevel ?? "full");

  const deviceIdentity = await (async () => {
    let hostname: string;
    try {
      hostname = new URL(opts.url).hostname;
    } catch {
      return null;
    }
    // Local authenticated probes should stay device-bound so read/detail RPCs
    // are not scope-limited by the shared-auth scope stripping hardening.
    if (isLoopbackHost(hostname) && !(opts.auth?.token || opts.auth?.password)) {
      return null;
    }
    try {
      const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
      return loadOrCreateDeviceIdentity();
    } catch {
      // Read-only or restricted environments should still be able to run
      // token/password-auth detail probes without crashing on identity persistence.
      return null;
    }
  })();

  return await new Promise<GatewayProbeResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearProbeTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const armProbeTimer = (onTimeout: () => void) => {
      clearProbeTimer();
      timer = setTimeout(onTimeout, clampProbeTimeoutMs(opts.timeoutMs));
    };
    const settle = (result: Omit<GatewayProbeResult, "url">) => {
      if (settled) {
        return;
      }
      settled = true;
      clearProbeTimer();
      client.stop();
      // Track device-required rejections at the probe boundary so bursts of
      // CLI probes against an unpaired gateway stop spamming handshake-failed
      // logs. Any successful probe clears the entry so a newly-paired gateway
      // resumes normal probing immediately.
      if (result.ok) {
        clearDeviceRequiredCacheFor(opts.url);
      } else if (isDeviceRequiredClose(result.close)) {
        noteDeviceRequiredFailure(opts.url, Date.now());
      }
      resolve({ url: opts.url, ...result });
    };

    const client = new GatewayClient({
      url: opts.url,
      token: opts.auth?.token,
      password: opts.auth?.password,
      tlsFingerprint: opts.tlsFingerprint,
      scopes: [READ_SCOPE],
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      clientVersion: "dev",
      mode: GATEWAY_CLIENT_MODES.PROBE,
      instanceId,
      deviceIdentity,
      onConnectError: (err) => {
        connectError = formatErrorMessage(err);
      },
      onClose: (code, reason) => {
        close = { code, reason };
        if (connectLatencyMs == null) {
          settle({
            ok: false,
            connectLatencyMs,
            error: formatProbeCloseError(close),
            close,
            health: null,
            status: null,
            presence: null,
            configSnapshot: null,
          });
        }
      },
      onHelloOk: async () => {
        connectLatencyMs = Date.now() - startedAt;
        if (detailLevel === "none") {
          settle({
            ok: true,
            connectLatencyMs,
            error: null,
            close,
            health: null,
            status: null,
            presence: null,
            configSnapshot: null,
          });
          return;
        }
        // Once the gateway has accepted the session, a slow follow-up RPC should no longer
        // downgrade the probe to "unreachable". Give detail fetching its own budget.
        armProbeTimer(() => {
          settle({
            ok: false,
            connectLatencyMs,
            error: "timeout",
            close,
            health: null,
            status: null,
            presence: null,
            configSnapshot: null,
          });
        });
        try {
          if (detailLevel === "presence") {
            const presence = await client.request("system-presence");
            settle({
              ok: true,
              connectLatencyMs,
              error: null,
              close,
              health: null,
              status: null,
              presence: Array.isArray(presence) ? (presence as SystemPresence[]) : null,
              configSnapshot: null,
            });
            return;
          }
          const [health, status, presence, configSnapshot] = await Promise.all([
            client.request("health"),
            client.request("status"),
            client.request("system-presence"),
            client.request("config.get", {}),
          ]);
          settle({
            ok: true,
            connectLatencyMs,
            error: null,
            close,
            health,
            status,
            presence: Array.isArray(presence) ? (presence as SystemPresence[]) : null,
            configSnapshot,
          });
        } catch (err) {
          settle({
            ok: false,
            connectLatencyMs,
            error: formatErrorMessage(err),
            close,
            health: null,
            status: null,
            presence: null,
            configSnapshot: null,
          });
        }
      },
    });

    armProbeTimer(() => {
      settle({
        ok: false,
        connectLatencyMs,
        error: connectError ? `connect failed: ${connectError}` : "timeout",
        close,
        health: null,
        status: null,
        presence: null,
        configSnapshot: null,
      });
    });

    client.start();
  });
}
