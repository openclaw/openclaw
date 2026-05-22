import type { Command } from "commander";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../gateway/protocol/client-info.js";
import { withProgress } from "../progress.js";

export type GatewayRpcOpts = {
  config?: OpenClawConfig;
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  expectFinal?: boolean;
  json?: boolean;
};

export const gatewayCallOpts = (cmd: Command) =>
  cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    // No default: when --timeout is omitted, defer to the gateway handshake
    // budget resolved by callGateway (DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
    // OPENCLAW_HANDSHAKE_TIMEOUT_MS, or gateway.handshakeTimeoutMs from
    // openclaw.json). Hardcoding "10000" here defeated the configurable
    // default and made the slow-startup workaround unreachable from the CLI.
    .option("--timeout <ms>", "Timeout in ms (default: gateway handshake budget)")
    .option("--expect-final", "Wait for final response (agent)", false)
    .option("--json", "Output JSON", false);

export const callGatewayCli = async (method: string, opts: GatewayRpcOpts, params?: unknown) =>
  withProgress(
    {
      label: `Gateway ${method}`,
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await callGateway({
        config: opts.config,
        url: opts.url,
        token: opts.token,
        password: opts.password,
        method,
        params,
        expectFinal: Boolean(opts.expectFinal),
        // Only forward an explicit numeric timeout. Passing undefined lets
        // callGateway resolve the proper default (handshake budget +
        // env/config overrides) instead of being capped at a hardcoded 10 s.
        timeoutMs: opts.timeout !== undefined ? Number(opts.timeout) : undefined,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      }),
  );
