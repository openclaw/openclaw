import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import { GatewayControlUiIngressError } from "../plugins/gateway-ingress.types.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { RemoteControlUiIngressContext } from "./remote-control-ui-context.js";
import type { GatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import type { RemoteIngressPrincipalSnapshot } from "./remote-ingress-principal.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import type { GatewayClient } from "./server-methods/client-types.js";

/** Grant-owned RPC constructs its exact caller; ambient plugin invocation scopes never participate. */
export async function requestRemoteIngressGateway<T>(input: {
  host: GatewayControlUiIngressHost;
  pluginId: string;
  resolvePrincipal(): RemoteIngressPrincipalSnapshot;
  assertCurrent(): void;
  signal: AbortSignal;
  trackWork<U>(work: Promise<U>): Promise<U>;
  method: string;
  params: Record<string, unknown>;
  requestSignal?: AbortSignal;
  ingressContext?: RemoteControlUiIngressContext;
}): Promise<T> {
  const context = input.host.resolveGatewayContext?.();
  if (!context) {
    throw new GatewayControlUiIngressError(
      "unavailable",
      "Gateway request dispatch is unavailable.",
    );
  }
  const principal = input.resolvePrincipal();
  const signal = input.requestSignal
    ? AbortSignal.any([input.signal, input.requestSignal])
    : input.signal;
  const assertCurrent = () => {
    signal.throwIfAborted();
    input.assertCurrent();
    principal.assertCurrent();
    if (input.host.resolveGatewayContext?.() !== context) {
      throw new GatewayControlUiIngressError("closed", "Gateway request owner was replaced.");
    }
  };
  const hasCurrentClientAuthority = () => {
    try {
      assertCurrent();
      return true;
    } catch {
      return false;
    }
  };
  assertCurrent();
  const client: GatewayClient = {
    connectionSignal: signal,
    remoteControlUiIngress: input.ingressContext,
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { id: "gateway-client", version: "1", platform: "plugin", mode: "backend" },
      role: "operator",
      scopes: [...principal.scopes],
    },
    authenticatedUserProfile: principal.authenticatedUserProfile,
    preparedSessionProfile: principal.preparedSessionProfile,
    internal: {
      authenticatedOperator: true,
      remoteIngressPrincipal: principal,
      operatorDeviceTokenIdentity: null,
      operatorRoleActor: principal.operatorRoleActor,
      operatorAccessAuthority: principal.operatorAccessAuthority,
      pluginRuntimeOwnerId: input.pluginId,
    },
  };
  const captured = await captureGatewayOperatorRunAuthority({
    client,
    context,
    hasCurrentClientAuthority,
    invocationAuthority: { assertCurrent, signal },
  });
  try {
    assertCurrent();
    if (captured) {
      client.internal!.operatorRunAuthority = captured.authority;
    }
    const result = await dispatchGatewayRequestInProcess<T>(input.method, input.params, {
      client,
      context,
      signal,
      hasCurrentClientAuthority,
      methodRegistry: context.getGatewayMethodRegistry?.(),
      requestIdPrefix: "remote-ingress",
      assertPreparationCurrent: assertCurrent,
      sessionMutationCommitGuard: assertCurrent,
      assertCreatedInputSourceCurrent: assertCurrent,
      onExecution: (execution) => {
        void input.trackWork(execution);
        void input.ingressContext?.trackWork(execution);
      },
    });
    assertCurrent();
    return result;
  } finally {
    captured?.release();
  }
}
