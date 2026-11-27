import type { callGatewayFromCli } from "../cli/gateway-rpc.js";
import type { OperatorScope } from "../gateway/operator-scopes.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";

/** Dispatch an admitted meeting tool action using the caller's selected Gateway identity. */
export async function callMeetingToolGateway(options: {
  method: string;
  params: Record<string, unknown>;
  timeoutMs: number;
  scopes: OperatorScope[];
  gateway?: Pick<PluginRuntime["gateway"], "request">;
  loadGatewayCli: () => Promise<{ callGatewayFromCli: typeof callGatewayFromCli }>;
}): Promise<unknown> {
  const { method, params, timeoutMs, scopes } = options;
  try {
    // A hosted rejection belongs to that caller. Retrying over CLI would change identity.
    if (options.gateway) {
      return await options.gateway.request(method, params, { timeoutMs, scopes });
    }
    const { callGatewayFromCli } = await options.loadGatewayCli();
    return await callGatewayFromCli(method, { json: true, timeout: String(timeoutMs) }, params, {
      progress: false,
      scopes,
    });
  } catch (error) {
    const details =
      error && typeof error === "object" && "details" in error ? error.details : undefined;
    if (details && typeof details === "object") {
      return details;
    }
    throw error;
  }
}
