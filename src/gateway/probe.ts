import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "../infra/errors.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  GATEWAY_PARSE_ERROR_CLOSE_CODE,
  GATEWAY_PARSE_ERROR_CLOSE_REASON,
  GatewayClient,
} from "./client.js";
import { READ_SCOPE } from "./method-scopes.js";

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
}): Promise<GatewayProbeResult> {
  const startedAt = Date.now();
  const instanceId = randomUUID();
  let connectLatencyMs: number | null = null;
  let connectError: string | null = null;
  let close: GatewayProbeClose | null = null;
  let sawParseError = false;

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
      onConnectError: (err) => {
        connectError = formatErrorMessage(err);
        // Track if we've seen a parse error to enable fast-fail on close
        if (err.message.includes("Failed to parse JSON message from gateway")) {
          sawParseError = true;
        }
      },
      onClose: (code, reason) => {
        close = { code, reason };
        // In PROBE mode, a close with code 1008 and reason "parse error" (or after seeing
        // a parse-error connectError) is a fatal protocol error that should immediately
        // fail the probe, not wait for timeout.
        // This handles the case where the gateway sends non-JSON content.
        if (
          code === GATEWAY_PARSE_ERROR_CLOSE_CODE &&
          (reason === GATEWAY_PARSE_ERROR_CLOSE_REASON || sawParseError)
        ) {
          settle({
            ok: false,
            connectLatencyMs,
            error: connectError ?? `gateway protocol error: ${reason}`,
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
        try {
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

    const timer = setTimeout(
      () => {
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
