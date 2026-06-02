import type { Command } from "commander";
import type {
  GatewayClientMode,
  GatewayClientName,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { OperatorScope } from "../gateway/operator-scopes.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";
export type { GatewayRpcOpts } from "./gateway-rpc.types.js";

type GatewayRpcRuntimeModule = typeof import("./gateway-rpc.runtime.js");

const gatewayRpcRuntimeLoader = createLazyImportLoader<GatewayRpcRuntimeModule>(
  () => import("./gateway-rpc.runtime.js"),
);

async function loadGatewayRpcRuntime(): Promise<GatewayRpcRuntimeModule> {
  return gatewayRpcRuntimeLoader.load();
}

/** Adds the shared Gateway connection flags without pulling in the runtime WebSocket client. */
export function addGatewayClientOptions(cmd: Command) {
  return cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--timeout <ms>", "Timeout in ms", "30000")
    .option("--expect-final", "Wait for final response (agent)", false);
}

/**
 * Invokes a Gateway RPC from CLI code while keeping the heavy transport runtime lazy-loaded.
 *
 * Callers can override client identity/scopes for operator flows, but the default remains a
 * plain CLI client so shared subcommands produce consistent Gateway audit metadata.
 */
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
  const runtime = await loadGatewayRpcRuntime();
  return await runtime.callGatewayFromCliRuntime(method, opts, params, extra);
}
