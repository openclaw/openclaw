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
  /** WebSocket connect/handshake succeeded. */
  ok: boolean;
  /** All probe RPC calls succeeded (health/status/presence/config.get). */
  rpcOk: boolean;
  /** True when RPC failed due to missing scopes (cosmetic reachability issue). */
  scopeLimited: boolean;
  url: string;
  connectLatencyMs: number | null;
  /** Non-null when RPC failed (or connect failed). */
  error: string | null;
  close: GatewayProbeClose | null;
  health: unknown;
  status: unknown;
  presence: SystemPresence[] | null;
  configSnapshot: unknown;
};

export async function probeGateway(opts: {
  url: string;
  auth?: GatewayProbeAuth;
  timeoutMs: number;
  includeDetails?: boolean;
}): Promise<GatewayProbeResult> {
  const startedAt = Date.now();
  const instanceId = randomUUID();
  let connectLatencyMs: number | null = null;
  let connectError: string | null = null;
  let close: GatewayProbeClose | null = null;

  const disableDeviceIdentity = (() => {
    try {
      return isLoopbackHost(new URL(opts.url).hostname);
    } catch {
      return false;
    }
  })();

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

        if (opts.includeDetails === false) {
          settle({
            ok: true,
            rpcOk: true,
            scopeLimited: false,
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

        const results = await Promise.allSettled([
          client.request("health"),
          client.request("status"),
          client.request("system-presence"),
          client.request("config.get", {}),
        ]);

        const [healthRes, statusRes, presenceRes, configRes] = results;

        const rejected = results.find((r) => r.status === "rejected");
        const errorText = rejected ? formatErrorMessage(rejected.reason) : null;
        const rpcOk = !rejected;
        const scopeLimited = Boolean(errorText && /missing scope:/i.test(errorText));

        const health = healthRes?.status === "fulfilled" ? healthRes.value : null;
        const status = statusRes?.status === "fulfilled" ? statusRes.value : null;
        const presenceRaw = presenceRes?.status === "fulfilled" ? presenceRes.value : null;
        const configSnapshot = configRes?.status === "fulfilled" ? configRes.value : null;

        settle({
          ok: true,
          rpcOk,
          scopeLimited,
          connectLatencyMs,
          error: errorText,
          close,
          health,
          status,
          presence: Array.isArray(presenceRaw) ? (presenceRaw as SystemPresence[]) : null,
          configSnapshot,
        });
      },
    });

    const timer = setTimeout(
      () => {
        settle({
          ok: false,
          rpcOk: false,
          scopeLimited: false,
          connectLatencyMs,
          error: connectError ? `connect failed: ${connectError}` : "timeout",
          close,
          health: null,
          status: null,
          presence: null,
          configSnapshot: null,
        });
      },
      Math.max(250, opts.timeoutMs),
    );

    client.start();
  });
}
