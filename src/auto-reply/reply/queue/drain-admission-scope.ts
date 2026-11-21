// Detached queue work re-admits on the generation current at execution time.
import { runOutsidePreparedModelRuntimePluginGenerationScope } from "../../../agents/prepared-model-runtime-generation-scope.js";
import { runWithAgentWorkspaceReadiness } from "../../../agents/workspace-readiness.js";
import { pluginInstanceInvocation } from "../../../plugins/plugin-instance-invocation.js";
import { pluginInvocationContext } from "../../../plugins/plugin-instance-scope.js";
import { runOutsidePluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";

/** Re-admit detached work without inheriting finite custody from the preceding turn. */
export function runOutsideAdmittedTurnScopes<T>(run: () => Promise<T>): Promise<T> {
  return runOutsidePreparedModelRuntimePluginGenerationScope(() =>
    runOutsidePluginRuntimeGenerationScope(() =>
      pluginInvocationContext.exit(() =>
        pluginInstanceInvocation.exit(() => runWithAgentWorkspaceReadiness(undefined, run)),
      ),
    ),
  );
}
