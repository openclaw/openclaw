import type { Command } from "commander";
import { readSourceConfigBestEffort } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../gateway/protocol/client-info.js";
import { defaultRuntime } from "../../runtime.js";
import { withProgress } from "../progress.js";
import { parsePort } from "../shared/parse-port.js";

export type GatewayRpcOpts = {
  config?: OpenClawConfig;
  url?: string;
  port?: string;
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
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--expect-final", "Wait for final response (agent)", false)
    .option("--json", "Output JSON", false);

async function resolveConfigWithPort(
  base: OpenClawConfig | undefined,
  port: string | undefined,
): Promise<OpenClawConfig | undefined> {
  if (!port) {
    return base;
  }
  const parsed = parsePort(port);
  if (parsed === null) {
    defaultRuntime.error("Invalid port");
    defaultRuntime.exit(1);
    return base;
  }
  // Load real config so auth, TLS, and mode settings are preserved.
  const real = base ?? (await readSourceConfigBestEffort());
  return { ...real, gateway: { ...real.gateway, port: parsed } };
}

export const callGatewayCli = async (method: string, opts: GatewayRpcOpts, params?: unknown) =>
  withProgress(
    {
      label: `Gateway ${method}`,
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await callGateway({
        config: await resolveConfigWithPort(opts.config, opts.port),
        url: opts.url,
        token: opts.token,
        password: opts.password,
        method,
        params,
        expectFinal: Boolean(opts.expectFinal),
        timeoutMs: Number(opts.timeout ?? 10_000),
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      }),
  );
