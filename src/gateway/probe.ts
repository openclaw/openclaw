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

export async function probeGateway(opts: {
  url: string;
  auth?: GatewayProbeAuth;
  timeoutMs: number;
  tlsFingerprint?: string;
  includeDetails?: boolean;
  detailLevel?: "none" | "presence" | "health" | "full";
  allowLoopbackDeviceIdentity?: boolean;
}): Promise<GatewayProbeResult> {
  const startedAt = Date.now();
  const instanceId = randomUUID();
  let connectLatencyMs: number | null = null;
  let connectError: string | null = null;
  let close: GatewayProbeClose | null = null;

  const disableDeviceIdentity = (() => {
    try {
      const hostname = new URL(opts.url).hostname;
      // Unauthenticated local probes disable device identity to avoid silently
      // inflating the probe's privilege via device-token fallback.
      // `allowLoopbackDeviceIdentity: true` opts trusted daemon loopback callers
      // back into the device identity path when that is the intended auth mechanism.
      return (
        isLoopbackHost(hostname) &&
        !(opts.auth?.token || opts.auth?.password) &&
        opts.allowLoopbackDeviceIdentity !== true
      );
    } catch {
      return false;
    }
  })();

  const detailLevel = opts.includeDetails === false ? "none" : (opts.detailLevel ?? "full");

  return await new Promise<GatewayProbeResult>((resolve) => {
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
      token: opts.auth?.token,
      password: opts.auth?.password,
      tlsFingerprint: opts.tlsFingerprint,
      scopes: [READ_SCOPE],
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      clientVersion: "dev",
      mode: GATEWAY_CLIENT_MODES.PROBE,
      instanceId,
      deviceIdentity: disableDeviceIdentity ? null : undefined,
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
          if (detailLevel === "health") {
            const health = await client.request("health");
            settle({
              ok: true,
              connectLatencyMs,
              error: null,
              close,
              health,
              status: null,
              presence: null,
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
    }, clampProbeTimeoutMs(opts.timeoutMs));

    client.start();
  });
}
