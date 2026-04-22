import { callGateway } from "../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../gateway/protocol/client-info.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";
import { withProgress } from "./progress.js";

/**
 * Resolve the gateway auth token for a CLI RPC call, preferring the
 * explicit --token flag and falling back to OPENCLAW_GATEWAY_TOKEN.
 * The embedded agent already reads this env var at runtime; without
 * this fallback the CLI side hangs for ~16s before failing unless
 * users pass --token manually. (#70365)
 */
function resolveCliGatewayToken(flagToken: string | undefined): string | undefined {
  const explicit = normalizeOptionalString(flagToken);
  if (explicit !== undefined) {
    return explicit;
  }
  return normalizeOptionalString(process.env.OPENCLAW_GATEWAY_TOKEN);
}

export async function callGatewayFromCliRuntime(
  method: string,
  opts: GatewayRpcOpts,
  params?: unknown,
  extra?: { expectFinal?: boolean; progress?: boolean },
) {
  const showProgress = extra?.progress ?? opts.json !== true;
  const token = resolveCliGatewayToken(opts.token);
  return await withProgress(
    {
      label: `Gateway ${method}`,
      indeterminate: true,
      enabled: showProgress,
    },
    async () =>
      await callGateway({
        url: opts.url,
        token,
        method,
        params,
        expectFinal: extra?.expectFinal ?? Boolean(opts.expectFinal),
        timeoutMs: Number(opts.timeout ?? 10_000),
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      }),
  );
}
