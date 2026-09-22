import { getPluginExecutionFrame, InvocationFrame } from "../plugin-instance-invocation.js";
import type { PluginExecutionScopes } from "../plugin-instance-invocation.types.js";
import type { PluginRegistry } from "../registry-types.js";
import type { PluginRuntimeGatewayRequestScope } from "./gateway-request-scope.types.js";

export class PluginRuntimeExecutionFrame extends InvocationFrame {
  constructor(
    scopes: PluginExecutionScopes,
    readonly gatewayScope: PluginRuntimeGatewayRequestScope | undefined,
    readonly generationRegistry: PluginRegistry | undefined,
  ) {
    super(scopes);
  }

  override withScopes(scopes: PluginExecutionScopes): PluginRuntimeExecutionFrame {
    return new PluginRuntimeExecutionFrame(scopes, this.gatewayScope, this.generationRegistry);
  }
}

export function getPluginRuntimeExecutionFrame(frame = getPluginExecutionFrame()) {
  return frame instanceof PluginRuntimeExecutionFrame ? frame : undefined;
}
