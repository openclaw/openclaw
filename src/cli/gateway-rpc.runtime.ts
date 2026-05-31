import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { callGateway, resolveGatewayCliScopes } from "../gateway/call.js";
import { shouldUseDirectLoopbackGatewayAuth } from "./direct-loopback-gateway-auth.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";
import { parseTimeoutMsWithFallback } from "./parse-timeout.js";
import { withProgress } from "./progress.js";

type CallGatewayFromCliRuntimeExtra = {
  clientName?: Parameters<typeof callGateway>[0]["clientName"];
  mode?: Parameters<typeof callGateway>[0]["mode"];
  deviceIdentity?: Parameters<typeof callGateway>[0]["deviceIdentity"];
  expectFinal?: boolean;
  progress?: boolean;
  scopes?: Parameters<typeof callGateway>[0]["scopes"];
};

const DEFAULT_GATEWAY_RPC_TIMEOUT_MS = 10_000;

export async function callGatewayFromCliRuntime(
  method: string,
  opts: GatewayRpcOpts,
  params?: unknown,
  extra?: CallGatewayFromCliRuntimeExtra,
) {
  const showProgress = extra?.progress ?? opts.json !== true;
  const useDirectAuth =
    (await shouldUseDirectLoopbackGatewayAuth(opts)) &&
    extra?.clientName === undefined &&
    extra?.mode === undefined &&
    extra?.deviceIdentity === undefined;
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
        deviceIdentity:
          extra?.deviceIdentity !== undefined
            ? extra.deviceIdentity
            : useDirectAuth
              ? null
              : undefined,
        expectFinal: extra?.expectFinal ?? Boolean(opts.expectFinal),
        scopes:
          extra?.scopes ?? (useDirectAuth ? resolveGatewayCliScopes(method, params) : undefined),
        timeoutMs: parseTimeoutMsWithFallback(opts.timeout, DEFAULT_GATEWAY_RPC_TIMEOUT_MS),
        clientName:
          extra?.clientName ??
          (useDirectAuth ? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT : GATEWAY_CLIENT_NAMES.CLI),
        mode:
          extra?.mode ?? (useDirectAuth ? GATEWAY_CLIENT_MODES.BACKEND : GATEWAY_CLIENT_MODES.CLI),
      }),
  );
}
