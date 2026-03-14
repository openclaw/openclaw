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
  const debug = process.env.OPENCLAW_DEBUG_GATEWAY_PROBE === "1";
  const dbg = (...args: unknown[]) => {
    if (debug) {
      // eslint-disable-next-line no-console
      console.error("[probe]", ...args);
    }
  };
  if (debug) {
    dbg("env", {
      HTTP_PROXY: Boolean(process.env.HTTP_PROXY || process.env.http_proxy),
      HTTPS_PROXY: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy),
      ALL_PROXY: Boolean(process.env.ALL_PROXY || process.env.all_proxy),
      NO_PROXY: Boolean(process.env.NO_PROXY || process.env.no_proxy),
      GLOBAL_AGENT_HTTP_PROXY: Boolean(process.env.GLOBAL_AGENT_HTTP_PROXY),
      GLOBAL_AGENT_HTTPS_PROXY: Boolean(process.env.GLOBAL_AGENT_HTTPS_PROXY),
      GLOBAL_AGENT_NO_PROXY: Boolean(process.env.GLOBAL_AGENT_NO_PROXY),
    });
  }

  const disableDeviceIdentity = (() => {
    try {
      return isLoopbackHost(new URL(opts.url).hostname);
    } catch {
      return false;
    }
  })();

  return await new Promise<GatewayProbeResult>((resolve) => {
    let settled = false;
    const settle = async (result: Omit<GatewayProbeResult, "url">) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      client.stop();
      await Promise.resolve();
      const finalizedError =
        result.ok || result.error !== "timeout"
          ? result.error
          : connectError
            ? `connect failed: ${connectError}`
            : result.error;
      const finalizedClose = close ?? result.close;
      settled = true;
      dbg("settle", { ok: result.ok, error: finalizedError, close: finalizedClose, connectError });
      resolve({ url: opts.url, ...result, error: finalizedError, close: finalizedClose });
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
        dbg("onConnectError", connectError);
      },
      onClose: (code, reason) => {
        close = { code, reason };
        dbg("onClose", code, reason);
      },
      onEvent: (evt) => {
        if (evt?.event === "connect.challenge") {
          const nonce = (evt as { payload?: { nonce?: string } }).payload?.nonce;
          dbg("onEvent connect.challenge", nonce ? "nonce" : "missing");
        } else if (evt?.event === "tick") {
          dbg("onEvent tick");
        }
      },
      onHelloOk: async () => {
        connectLatencyMs = Date.now() - startedAt;
        dbg("onHelloOk", connectLatencyMs);
        if (opts.includeDetails === false) {
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
          dbg("request health/status/presence/config");
          const [health, status, presence, configSnapshot] = await Promise.all([
            client.request("health"),
            client.request("status"),
            client.request("system-presence"),
            client.request("config.get", {}),
          ]);
          dbg("requests resolved");
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
          dbg("requests failed", formatErrorMessage(err));
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

    const timer = setTimeout(
      () => {
        dbg("timeout fired", { connectError, close });
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
      },
      Math.max(250, opts.timeoutMs),
    );

    client.start();
  });
}
