import type { Command } from "commander";
import type {
  GatewayClientMode,
  GatewayClientName,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { OperatorScope } from "../gateway/operator-scopes.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";
import { parsePositiveIntOrUndefined } from "./program/helpers.js";
export type { GatewayRpcOpts } from "./gateway-rpc.types.js";

type GatewayRpcRuntimeModule = typeof import("./gateway-rpc.runtime.js");

const gatewayRpcRuntimeLoader = createLazyImportLoader<GatewayRpcRuntimeModule>(
  () => import("./gateway-rpc.runtime.js"),
);

async function loadGatewayRpcRuntime(): Promise<GatewayRpcRuntimeModule> {
  return gatewayRpcRuntimeLoader.load();
}

export function addGatewayClientOptions(cmd: Command) {
  return cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--timeout <ms>", "Timeout in ms", "30000")
    .option("--expect-final", "Wait for final response (agent)", false);
}

const DEFAULT_GATEWAY_RPC_TIMEOUT_MS = 30_000;

function resolveGatewayRpcTimeoutMs(timeout: unknown): number {
  if (timeout === undefined || timeout === null) {
    return DEFAULT_GATEWAY_RPC_TIMEOUT_MS;
  }
  if (typeof timeout === "string" && timeout.trim() === "") {
    throw new Error("--timeout must be a positive integer (milliseconds)");
  }
  const parsed = parsePositiveIntOrUndefined(timeout);
  if (parsed === undefined) {
    throw new Error("--timeout must be a positive integer (milliseconds)");
  }
  return parsed;
}

export async function callGatewayFromCli(
  method: string,
  opts: GatewayRpcOpts,
  params?: unknown,
  extra?: {
    clientName?: GatewayClientName;
    mode?: GatewayClientMode;
    deviceIdentity?: DeviceIdentity | null;
    expectFinal?: boolean;
    progress?: boolean;
    scopes?: OperatorScope[];
  },
) {
  const timeoutMs = resolveGatewayRpcTimeoutMs(opts.timeout);
  opts.timeout = String(timeoutMs);
  const runtime = await loadGatewayRpcRuntime();
  return await runtime.callGatewayFromCliRuntime(method, opts, params, extra);
}
