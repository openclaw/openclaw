import type { Command } from "commander";
import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { withProgress } from "../progress.js";

export type GatewayRpcOpts = {
  config?: OpenClawConfig;
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  expectFinal?: boolean;
  json?: boolean;
  header?: string[];
};

/**
 * Parse repeatable `--header "Name: Value"` flags into a headers record.
 * Also merges headers from the `OPENCLAW_GATEWAY_HEADERS` env var
 * (comma-separated `Name: Value` pairs) and from the config file
 * (`gateway.remote.headers`). Precedence: CLI > env > config.
 */
function resolveGatewayHeaders(opts: GatewayRpcOpts): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  let hasHeaders = false;

  // Lowest precedence: config file gateway.remote.headers
  const configHeaders = opts.config?.gateway?.remote?.headers;
  if (configHeaders && typeof configHeaders === "object") {
    for (const [key, value] of Object.entries(configHeaders)) {
      if (typeof key === "string" && key.trim().length > 0 && typeof value === "string") {
        merged[key.trim()] = value;
        hasHeaders = true;
      }
    }
  }

  // Middle precedence: OPENCLAW_GATEWAY_HEADERS env var (comma-separated "Name: Value" pairs)
  const envHeaders = process.env.OPENCLAW_GATEWAY_HEADERS;
  if (typeof envHeaders === "string" && envHeaders.trim().length > 0) {
    for (const entry of envHeaders.split(",")) {
      const colonIdx = entry.indexOf(":");
      if (colonIdx > 0) {
        const key = entry.slice(0, colonIdx).trim();
        const value = entry.slice(colonIdx + 1).trim();
        if (key.length > 0) {
          merged[key] = value;
          hasHeaders = true;
        }
      }
    }
  }

  // Highest precedence: CLI --header flags
  if (Array.isArray(opts.header)) {
    for (const entry of opts.header) {
      const colonIdx = entry.indexOf(":");
      if (colonIdx > 0) {
        const key = entry.slice(0, colonIdx).trim();
        const value = entry.slice(colonIdx + 1).trim();
        if (key.length > 0) {
          merged[key] = value;
          hasHeaders = true;
        }
      }
    }
  }

  return hasHeaders ? merged : undefined;
}

export const gatewayCallOpts = (cmd: Command) =>
  cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option(
      "--header <header>",
      "Custom HTTP header for WebSocket upgrade (repeatable, format: Name: Value)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--timeout <ms>", "Timeout in ms", "10000")
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
        headers: resolveGatewayHeaders(opts),
        method,
        params,
        expectFinal: Boolean(opts.expectFinal),
        timeoutMs: Number(opts.timeout ?? 10_000),
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      }),
  );
