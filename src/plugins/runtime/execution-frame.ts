import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { getPluginExecutionFrame, InvocationFrame } from "../plugin-instance-invocation.js";
import type { PluginExecutionScopes } from "../plugin-instance-invocation.types.js";
import type { PluginRegistry } from "../registry-types.js";
import type { PluginRuntimeGatewayRequestScope } from "./gateway-request-scope.types.js";

export interface PluginRuntimeExecutionFrame extends InvocationFrame {
  readonly gatewayScope: PluginRuntimeGatewayRequestScope | undefined;
  readonly generationRegistry: PluginRegistry | undefined;
  withScopes(scopes: PluginExecutionScopes): PluginRuntimeExecutionFrame;
}

// The frame store is one process-wide singleton, so every module instance that
// reads it (source, built chunks, reloaded graphs) must narrow with one constructor.
export const PluginRuntimeExecutionFrame: {
  new (
    scopes: PluginExecutionScopes,
    gatewayScope: PluginRuntimeGatewayRequestScope | undefined,
    generationRegistry: PluginRegistry | undefined,
    invocation?: PluginExecutionScopes["invocation"],
    inputRecoveryContext?: PluginExecutionScopes["inputRecoveryContext"],
  ): PluginRuntimeExecutionFrame;
  readonly prototype: PluginRuntimeExecutionFrame;
} = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginRuntimeExecutionFrame"),
  () =>
    class RuntimeFrame extends InvocationFrame {
      constructor(
        scopes: PluginExecutionScopes,
        readonly gatewayScope: PluginRuntimeGatewayRequestScope | undefined,
        readonly generationRegistry: PluginRegistry | undefined,
        invocation = scopes.invocation,
        inputRecoveryContext = scopes.inputRecoveryContext,
      ) {
        super(scopes, invocation, inputRecoveryContext);
      }

      override get runtimePluginId(): string | undefined {
        return this.gatewayScope?.pluginId;
      }

      override withScopes(scopes: PluginExecutionScopes): RuntimeFrame {
        return new RuntimeFrame(scopes, this.gatewayScope, this.generationRegistry);
      }
    },
);

export function getPluginRuntimeExecutionFrame(
  frame = getPluginExecutionFrame(),
): PluginRuntimeExecutionFrame | undefined {
  return frame instanceof PluginRuntimeExecutionFrame ? frame : undefined;
}
