// Detached queue work re-admits on the generation current at execution time.
import { runOutsidePreparedModelRuntimePluginGenerationScope } from "../../../agents/prepared-model-runtime-generation-scope.js";
import { pluginInstanceInvocation } from "../../../plugins/plugin-instance-invocation.js";
import { pluginInvocationContext } from "../../../plugins/plugin-instance-scope.js";
import { runOutsidePluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";

/** Re-admit detached work without inheriting finite custody from the preceding turn. */
export function runOutsideAdmittedGenerationScopes<T>(run: () => T): T {
  return runOutsidePreparedModelRuntimePluginGenerationScope(() =>
    runOutsidePluginRuntimeGenerationScope(() =>
      pluginInvocationContext.exit(() => pluginInstanceInvocation.exit(run)),
    ),
  );
}
