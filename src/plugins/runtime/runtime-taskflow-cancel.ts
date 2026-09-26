import {
  captureTaskFlowCancellationSelection,
  type TaskFlowCancellationRequest,
} from "../../tasks/task-flow-cancellation.types.js";
import { pluginInstanceInvocation } from "../plugin-instance-invocation.js";
import { hasCurrentPluginInstanceAuthority } from "../plugin-instance-scope.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";

/** Retain the calling instance and request through the cancellation owner's awaited writes. */
export async function cancelRuntimeTaskFlow(
  params: TaskFlowCancellationRequest & { callerOwnerKey: string },
) {
  const input = {
    ...params,
    ...(params.expectedFlow
      ? {
          expectedFlow: {
            ...captureTaskFlowCancellationSelection(params.expectedFlow),
            revision: params.expectedFlow.revision,
          },
        }
      : {}),
  };
  const invocation = pluginInstanceInvocation.getStore();
  const request = getPluginRuntimeGatewayRequestScope();
  const assertCurrent = () => {
    if (
      invocation &&
      (!hasCurrentPluginInstanceAuthority(invocation.instance.pluginId) ||
        pluginInstanceInvocation.getStore()?.token !== invocation.token)
    ) {
      throw new Error("Plugin cancellation invocation is no longer active.");
    }
    request?.signal?.throwIfAborted();
    if (request?.hasCurrentClientAuthority?.() === false) {
      throw new Error("Gateway caller authority is no longer active.");
    }
  };
  assertCurrent();
  const { cancelFlowByIdForOwner } = await import("../../tasks/task-flow-cancellation.async.js");
  assertCurrent();
  return cancelFlowByIdForOwner(input, assertCurrent);
}
