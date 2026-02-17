import type { Command } from "commander";
import { callGateway } from "../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { withProgress } from "./progress.js";

export type GatewayRpcOpts = {
  url?: string;
  token?: string;
  timeout?: string;
  expectFinal?: boolean;
  json?: boolean;
};

export function addGatewayClientOptions(cmd: Command, opts?: { defaultTimeoutMs?: number }) {
  const defaultTimeout = String(opts?.defaultTimeoutMs ?? 30_000);
  return cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--timeout <ms>", "Timeout in ms", defaultTimeout)
    .option("--expect-final", "Wait for final response (agent)", false);
}

const CRON_RETRY_METHODS = new Set(["cron.status", "cron.list", "cron.runs"]);
const CRON_RETRY_DELAY_MS = 250;

function isGatewayTimeout(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("gateway timeout after ");
}

export async function callGatewayFromCli(
  method: string,
  opts: GatewayRpcOpts,
  params?: unknown,
  extra?: { expectFinal?: boolean; progress?: boolean },
) {
  const showProgress = extra?.progress ?? opts.json !== true;
  const doCall = () =>
    withProgress(
      {
        label: `Gateway ${method}`,
        indeterminate: true,
        enabled: showProgress,
      },
      async () =>
        await callGateway({
          url: opts.url,
          token: opts.token,
          method,
          params,
          expectFinal: extra?.expectFinal ?? Boolean(opts.expectFinal),
          timeoutMs: Number(opts.timeout ?? 10_000),
          clientName: GATEWAY_CLIENT_NAMES.CLI,
          mode: GATEWAY_CLIENT_MODES.CLI,
        }),
    );

  try {
    return await doCall();
  } catch (err) {
    if (CRON_RETRY_METHODS.has(method) && isGatewayTimeout(err)) {
      await new Promise((r) => setTimeout(r, CRON_RETRY_DELAY_MS));
      return await doCall();
    }
    throw err;
  }
}
