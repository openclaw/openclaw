import type { Command } from "commander";
import { addGatewayClientOptions, callGatewayFromCliWithTransport } from "../gateway-rpc.js";
export type GatewayRpcOpts = Parameters<typeof callGatewayFromCliWithTransport>[1];
const DEFAULT_GATEWAY_RPC_TIMEOUT_MS = 10_000;

export function gatewayCallOpts(
  cmd: Command,
  defaultTimeoutMs = DEFAULT_GATEWAY_RPC_TIMEOUT_MS,
): Command {
  return addGatewayClientOptions(cmd, { timeoutMs: defaultTimeoutMs }).option(
    "--json",
    "Output JSON",
    false,
  );
}

export async function callGatewayReadOnlyCli(
  method: string,
  opts: GatewayRpcOpts,
  params?: unknown,
) {
  return await callGatewayFromCliWithTransport(method, opts, params, {
    defaultTimeoutMs: DEFAULT_GATEWAY_RPC_TIMEOUT_MS,
    sharedStateMode: "read-only",
  });
}

export function parseGatewayCallParams(value = "{}"): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("--params must be valid JSON.");
  }
}
