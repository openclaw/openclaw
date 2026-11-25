import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import {
  prepareResolvedSessionSend,
  type ResolvedSessionSendInput,
} from "../config/sessions/resolved-session-send.js";
import { dispatchGatewayMethodInProcessRaw } from "../gateway/server-plugins.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";

class GatewayMethodDispatchForbidden extends Error {}

/** Error envelope returned by in-process Gateway method dispatch. */
export type GatewayMethodDispatchError = NonNullable<GatewayMethodDispatchResponse["error"]>;

/** Response envelope returned to plugins after dispatching a Gateway method. */
export type GatewayMethodDispatchResponse = SchemaContract<
  Awaited<ReturnType<typeof dispatchGatewayMethodInProcessRaw>>
>;

/** Dispatch controls for plugin-initiated Gateway method calls. */
export type GatewayMethodDispatchOptions = {
  /** Wait for the Gateway's final response instead of returning the first response frame. */
  expectFinal?: boolean;
  /** Maximum time to wait for Gateway dispatch before the runtime reports a timeout. */
  timeoutMs?: number;
};

/**
 * Dispatch a Gateway control-plane method from an authenticated plugin request scope.
 */
export async function dispatchGatewayMethod(
  /** Gateway method name, validated by the Gateway method router. */
  method: string,
  /** Method-specific params forwarded without SDK-side normalization. */
  params?: unknown,
  /** Dispatch behavior controls for response timing and timeout handling. */
  options?: GatewayMethodDispatchOptions,
): Promise<GatewayMethodDispatchResponse> {
  const scope = getPluginRuntimeGatewayRequestScope();
  if (scope?.gatewayMethodDispatchAllowed !== true) {
    // Gateway methods can mutate/control local runtime state; require the
    // authenticated request scope recorded by the plugin loader contract.
    const pluginLabel = scope?.pluginId ? ` for plugin "${scope.pluginId}"` : "";
    throw new GatewayMethodDispatchForbidden(
      `Gateway method dispatch is reserved for authenticated plugin HTTP routes or RPC handlers that declare contracts.gatewayMethodDispatch: ["authenticated-request"]${pluginLabel}.`,
    );
  }
  return await dispatchGatewayMethodInProcessRaw(method, params, {
    disableSyntheticClient: true,
    requireScopedClient: true,
    ...(scope.signal ? { signal: scope.signal } : {}),
    ...(scope.hasCurrentClientAuthority
      ? { hasCurrentClientAuthority: scope.hasCurrentClientAuthority }
      : {}),
    ...(options?.expectFinal !== undefined ? { expectFinal: options.expectFinal } : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

/** Submit a message to the physical session returned by catalog resolution in this caller's Gateway scope. */
export async function sendToResolvedSession(
  input: ResolvedSessionSendInput,
): Promise<"accepted" | "forbidden" | "unconfirmed"> {
  const send = prepareResolvedSessionSend(input);
  if (!send) {
    return "unconfirmed";
  }
  try {
    const reply = await dispatchGatewayMethod("chat.send", send.params);
    if (!reply.ok && reply.error?.code === "FORBIDDEN") {
      return "forbidden";
    }
    return reply.ok && send.acknowledged(reply.payload) ? "accepted" : "unconfirmed";
  } catch (error) {
    return error instanceof GatewayMethodDispatchForbidden ? "forbidden" : "unconfirmed";
  }
}
