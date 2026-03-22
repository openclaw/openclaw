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

function isLocalSharedAuthScopeFailure(opts: {
  url: string;
  auth?: GatewayProbeAuth;
  result: GatewayProbeResult;
  allowLocalDeviceAuthRetry?: boolean;
}): boolean {
  if (opts.allowLocalDeviceAuthRetry !== true) {
    return false;
  }
  if (!opts.auth?.token && !opts.auth?.password) {
    return false;
  }
  if (!opts.result.error?.includes(`missing scope: ${READ_SCOPE}`)) {
    return false;
  }
  try {
    const hostname = new URL(opts.url).hostname;
    return isLoopbackHost(hostname);
  } catch {
    return false;
  }
}

/**
 * Probe a gateway endpoint for connectivity and optional health/status details.
 *
 * When `allowLocalDeviceAuthRetry` is true and the first attempt fails with a
 * scope-stripping error on a loopback URL, the probe retries without explicit
 * auth so device-identity pairing can satisfy the scope requirement. Both
 * attempts share a single deadline computed from `timeoutMs`, so the total
 * wall-clock time never exceeds the caller's budget.
 */
export async function probeGateway(opts: {
  url: string;
  auth?: GatewayProbeAuth;
  timeoutMs: number;
  includeDetails?: boolean;
  detailLevel?: "none" | "presence" | "full";
  allowLocalDeviceAuthRetry?: boolean;
}): Promise<GatewayProbeResult> {
  const detailLevel = opts.includeDetails === false ? "none" : (opts.detailLevel ?? "full");
  // A single deadline governs both the initial attempt and any device-auth
  // retry so the caller's timeout budget is never exceeded.
  const deadlineAt = Date.now() + clampProbeTimeoutMs(opts.timeoutMs);
  const attemptProbe = async (
    auth?: GatewayProbeAuth,
    attemptOpts?: {
      forceDeviceIdentity?: boolean;
      clearDeviceAuthTokenOnMismatch?: boolean;
    },
  ): Promise<GatewayProbeResult> => {
    const startedAt = Date.now();
    const instanceId = randomUUID();
    let connectLatencyMs: number | null = null;
    let connectError: string | null = null;
    let close: GatewayProbeClose | null = null;

    const disableDeviceIdentity = (() => {
      try {
        const hostname = new URL(opts.url).hostname;
        // Local authenticated probes should stay device-bound so read/detail RPCs
        // are not scope-limited by the shared-auth scope stripping hardening.
        return (
          isLoopbackHost(hostname) &&
          !(auth?.token || auth?.password) &&
          attemptOpts?.forceDeviceIdentity !== true
        );
      } catch {
        return false;
      }
    })();

    return await new Promise<GatewayProbeResult>((resolve) => {
      const remainingBudgetMs = Math.max(1, deadlineAt - Date.now());
      let settled = false;
      const settle = (result: Omit<GatewayProbeResult, "url">) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        client.stop();
        resolve({ url: opts.url, ...result });
      };

      const client = new GatewayClient({
        url: opts.url,
        token: auth?.token,
        password: auth?.password,
        scopes: [READ_SCOPE],
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        clientVersion: "dev",
        mode: GATEWAY_CLIENT_MODES.PROBE,
        instanceId,
        deviceIdentity: disableDeviceIdentity ? null : undefined,
        clearDeviceAuthTokenOnMismatch: attemptOpts?.clearDeviceAuthTokenOnMismatch,
        onConnectError: (err) => {
          connectError = formatErrorMessage(err);
        },
        onClose: (code, reason) => {
          close = { code, reason };
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

      const timer = setTimeout(() => {
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
      }, remainingBudgetMs);

      client.start();
    });
  };

  const first = await attemptProbe(opts.auth);
  if (
    !isLocalSharedAuthScopeFailure({
      url: opts.url,
      auth: opts.auth,
      result: first,
      allowLocalDeviceAuthRetry: opts.allowLocalDeviceAuthRetry,
    })
  ) {
    return first;
  }
  const retry = await attemptProbe(undefined, {
    forceDeviceIdentity: true,
    clearDeviceAuthTokenOnMismatch: false,
  });
  return retry.ok ? retry : first;
}
