// Detached queue work re-admits under the turn and generation current at execution time.
import { runOutsidePreparedModelRuntimePluginGenerationScope } from "../../../agents/prepared-model-runtime-generation-scope.js";
import { runWithAgentWorkspaceReadiness } from "../../../agents/workspace-readiness.js";
import { runOutsidePluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";

/**
 * Drop the inherited generations and the starting turn's workspace gate without
 * dropping the original Gateway caller. A background exit callback runs in the async
 * context of the turn that started it; that turn's gate fails once it ends.
 */
export function runOutsideAdmittedTurnScopes<T>(run: () => Promise<T>): Promise<T> {
  return runOutsidePreparedModelRuntimePluginGenerationScope(() =>
    runOutsidePluginRuntimeGenerationScope(() => runWithAgentWorkspaceReadiness(undefined, run)),
  );
}
