import { callGateway } from "../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../gateway/protocol/client-info.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";
import { parseTimeoutMsWithFallback } from "./parse-timeout.js";
import { withProgress } from "./progress.js";

const DEFAULT_GATEWAY_RPC_TIMEOUT_MS = 30_000;

export async function callGatewayFromCliRuntime(
  method: string,
  opts: GatewayRpcOpts,
  params?: unknown,
  extra?: { expectFinal?: boolean; progress?: boolean },
) {
  const showProgress = extra?.progress ?? opts.json !== true;
  const timeoutMs = parseTimeoutMsWithFallback(opts.timeout, DEFAULT_GATEWAY_RPC_TIMEOUT_MS, {
    invalidType: "error",
  });
  return await withProgress(
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
        timeoutMs,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      }),
  );
}
