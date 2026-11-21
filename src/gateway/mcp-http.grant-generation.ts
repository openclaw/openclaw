// Run-bound loopback grants keep their CLI run's Gateway request scope, including the plugin
// generation the run started on. A plugin reload retires that generation while the run goes on,
// so every later loopback request would keep resolving the retired plugin and fail, for every
// tool, until the run ends. Embedded runs re-admit outside the retired generation at their next
// step; a loopback request is a CLI run's next step, so it does the same.
import { isPreparedModelRuntimePluginLifecycleFailure } from "../agents/prepared-model-runtime-admission-errors.js";
import { isPluginReloadingError } from "../plugins/plugin-replacement-retry.js";
import {
  ExpiredPluginRegistryScopeError,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.types.js";
import { runOutsidePluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";

// A retired generation never becomes current again, so a grant re-admits once and stays out.
const retiredGrantScopes = new WeakSet<PluginRuntimeGatewayRequestScope>();

/** Runs grant work in its request scope, outside its plugin generation once that retired. */
export function runInMcpGrantRequestScope<T>(
  scope: PluginRuntimeGatewayRequestScope,
  run: () => T,
): T {
  return withPluginRuntimeGatewayRequestScope(
    scope,
    retiredGrantScopes.has(scope) ? () => runOutsidePluginRuntimeGenerationScope(run) : run,
  );
}

/**
 * Builds tools in the grant's request scope. When the scope's plugin generation turns out to be
 * retired, builds them once more on the published generation, keeping the exact caller, and
 * keeps this grant's later requests there.
 */
export async function resolveInMcpGrantRequestScope<T>(
  scope: PluginRuntimeGatewayRequestScope,
  resolve: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  try {
    return await runInMcpGrantRequestScope(scope, resolve);
  } catch (error) {
    if (
      retiredGrantScopes.has(scope) ||
      !(
        isPreparedModelRuntimePluginLifecycleFailure(error) ||
        error instanceof ExpiredPluginRegistryScopeError
      )
    ) {
      throw error;
    }
    signal.throwIfAborted();
    // A reload still in flight settles first, so the retry reaches its published generation.
    if (isPluginReloadingError(error)) {
      await error.replacement;
      signal.throwIfAborted();
    }
    retiredGrantScopes.add(scope);
    return await runInMcpGrantRequestScope(scope, resolve);
  }
}
