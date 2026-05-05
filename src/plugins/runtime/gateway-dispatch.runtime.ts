// Narrow public seam for plugin runtime that needs to invoke a gateway method
// in-process under the current plugin's identity. The dispatch path stamps
// `client.internal.pluginRuntimeOwnerId` so handlers gated on that marker
// (e.g. `voicecall.start` per-call agentId/sessionKey) accept the request.
//
// Heavy gateway wiring is loaded lazily on first call to keep the
// `openclaw/plugin-sdk/plugin-runtime` barrel cheap at module load.

export type DispatchPluginGatewayRequestOptions = {
  /**
   * Plugin id that owns the request. Stamped onto
   * `client.internal.pluginRuntimeOwnerId` in the synthesized operator client
   * so trust-gated handlers honor the request as in-process plugin runtime.
   */
  pluginRuntimeOwnerId: string;
};

/**
 * Dispatches a gateway RPC method in-process under the calling plugin's
 * runtime identity. Resolves to the handler's response payload, or throws
 * with the handler's error message on failure.
 *
 * Use this from extension runtime code that needs to call another plugin's
 * gateway method (e.g. google-meet -> voice-call) without opening a fresh
 * WebSocket as an external operator client. Going through this helper keeps
 * the trust marker (`pluginRuntimeOwnerId`) intact so per-call routing
 * parameters (agentId, sessionKey, ...) survive the trust-boundary check.
 */
export async function dispatchPluginGatewayRequest<T = unknown>(
  method: string,
  params: Record<string, unknown>,
  options: DispatchPluginGatewayRequestOptions,
): Promise<T> {
  const { dispatchGatewayMethod } = await import("../../gateway/server-plugins.js");
  return dispatchGatewayMethod<T>(method, params, {
    pluginRuntimeOwnerId: options.pluginRuntimeOwnerId,
  });
}
