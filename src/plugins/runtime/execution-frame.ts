import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { getPluginExecutionFrame, InvocationFrame } from "../plugin-instance-invocation.js";
import type { PluginExecutionScopes } from "../plugin-instance-invocation.types.js";
import type { PluginRegistry } from "../registry-types.js";
import type { PluginRuntimeGatewayRequestScope } from "./gateway-request-scope.types.js";

// The frame store is one process-wide singleton, so every module instance that
// reads it (source, built chunks, reloaded graphs) must narrow with one constructor.
export const PluginRuntimeExecutionFrame = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginRuntimeExecutionFrame"),
  () =>
    class RuntimeFrame extends InvocationFrame {
      constructor(
        scopes: PluginExecutionScopes,
        readonly gatewayScope: PluginRuntimeGatewayRequestScope | undefined,
        readonly generationRegistry: PluginRegistry | undefined,
      ) {
        super(scopes);
      }

      override withScopes(scopes: PluginExecutionScopes): RuntimeFrame {
        return new RuntimeFrame(scopes, this.gatewayScope, this.generationRegistry);
      }
    },
);

export function getPluginRuntimeExecutionFrame(frame = getPluginExecutionFrame()) {
  return frame instanceof PluginRuntimeExecutionFrame ? frame : undefined;
}
