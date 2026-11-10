import { getPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  captureRequesterModelPolicySnapshot,
  intersectOperatorModelPolicies,
} from "../../operator-model-policy-state.js";
import { captureRequesterOrigin, requesterCreatorProfileId } from "../../requester-origin.js";
import {
  getGatewayToolCallerIdentity,
  resolveGatewayToolOperatorSelection,
} from "../../tools/gateway-caller-context.js";

/** Captures the request's Gateway binding and operator owner before spawn preparation awaits. */
export function captureSubagentSpawnGatewayContext() {
  const gatewayCaller = getGatewayToolCallerIdentity();
  const gatewayScope = getPluginRuntimeGatewayRequestScope();
  const gatewayContextResolver =
    gatewayCaller?.gatewayContextResolver ??
    gatewayScope?.resolveGatewayContext ??
    gatewayScope?.context?.resolveGatewayContext;
  const selection = resolveGatewayToolOperatorSelection({ requireRequesterOrigin: true });
  const operatorAuthority =
    selection.operatorAuthority ?? gatewayScope?.client?.internal?.operatorRunAuthority;
  const requesterOrigin = selection.requesterOrigin
    ? captureRequesterOrigin({ requesterOrigin: selection.requesterOrigin })
    : undefined;
  const requester =
    gatewayCaller && requesterOrigin
      ? Object.freeze({
          agentId: gatewayCaller.agentId,
          sessionKey: gatewayCaller.sessionKey,
          requesterOrigin,
        })
      : undefined;
  return {
    gatewayContextResolver,
    operatorAuthority,
    modelCeiling: captureRequesterModelPolicySnapshot(
      intersectOperatorModelPolicies(gatewayCaller?.modelPolicy, operatorAuthority?.modelPolicy),
    ),
    requester,
    // Personal-tool selection changes authority, not who caused this delegation.
    creatorProfileId: requesterCreatorProfileId(gatewayCaller?.requesterOrigin),
  };
}
