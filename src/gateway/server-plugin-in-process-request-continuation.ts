import { resolveLeastPrivilegeOperatorScopesForMethod } from "./method-scopes.js";
import {
  captureOperatorToolGatewayContinuationContextInternal,
  resolveInProcessGatewayDispatch,
} from "./server-plugin-in-process-authority.js";

/** Authorize one fixed request before the turn yields, then retain only its source. */
export async function captureOperatorToolGatewayRequestContinuationContext(
  target: { sessionKey: string; agentId?: string },
  request: { method: string; params: Record<string, unknown> },
) {
  const fixed = { method: request.method, params: structuredClone(request.params) };
  const captured = await captureOperatorToolGatewayContinuationContextInternal(target, {
    request: fixed,
  });
  if (!captured) {
    return undefined;
  }
  try {
    await captured.run(async () => {
      const resolved = resolveInProcessGatewayDispatch(fixed.method, fixed.params, {
        forceSyntheticClient: true,
        syntheticScopes: resolveLeastPrivilegeOperatorScopesForMethod(fixed.method, fixed.params),
        syntheticScopeMode: "minimum",
      });
      const [{ authorizeGatewayRequestPreDispatch }, { createRequestGatewayMethodRegistry }] =
        await Promise.all([
          import("./server-methods/request-authorization.js"),
          import("./server-methods.js"),
        ]);
      captured.assertCurrent();
      const authorization = await authorizeGatewayRequestPreDispatch({
        method: fixed.method,
        requestParams: fixed.params,
        client: resolved.client,
        context: resolved.context,
        methodRegistry:
          resolved.context.getGatewayMethodRegistry?.() ?? createRequestGatewayMethodRegistry(),
        hasCurrentClientAuthority: resolved.hasCurrentClientAuthority,
        assertInvocationCurrent: captured.assertCurrent,
      });
      try {
        captured.assertCurrent();
        if (authorization.error) {
          const { unwrapGatewayMethodDispatchResponse } =
            await import("./server-in-process-dispatch.js");
          unwrapGatewayMethodDispatchResponse(fixed.method, {
            ok: false,
            error: authorization.error,
          });
        }
        authorization.sessionAccessAuthority?.assertCurrent();
        authorization.sessionMutationAuthorization?.assertCurrent();
      } finally {
        authorization.sessionMutationAuthorization?.release?.();
        authorization.sessionAccessAuthority?.release();
      }
    });
  } catch (error) {
    captured.release();
    throw error;
  }
  let dispatched = false;
  return {
    assertCurrent: captured.assertCurrent,
    operatorAuthority: captured.operatorAuthority,
    signal: captured.signal,
    release: captured.release,
    async dispatch(options: { assertCurrent: () => void; signal: AbortSignal }) {
      captured.assertCurrent();
      if (dispatched) {
        throw new Error("Gateway request continuation already dispatched");
      }
      dispatched = true;
      const { callAgentToolGatewayRequest } = await import("../agents/tools/in-process-gateway.js");
      return await captured.run(() =>
        callAgentToolGatewayRequest({
          method: fixed.method,
          params: fixed.params,
          sessionMutationCommitGuard: options.assertCurrent,
          signal: options.signal,
          timeoutMs: null,
        }),
      );
    },
    async enqueueSessionEvent(
      text: string,
      options: Parameters<
        typeof import("../auto-reply/reply/session-event-handoff.js").enqueueSessionEventForHost
      >[1],
    ) {
      const { enqueueSessionEventForHost } =
        await import("../auto-reply/reply/session-event-handoff.js");
      const { runOutsidePluginRuntimeRegistryScope } =
        await import("../plugins/runtime/gateway-request-scope.js");
      return captured.run(() =>
        runOutsidePluginRuntimeRegistryScope(() => enqueueSessionEventForHost(text, options)),
      );
    },
  };
}
