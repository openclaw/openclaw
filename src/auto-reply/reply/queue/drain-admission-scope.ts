// Detached queue work re-admits on the generation current at execution time.
import { runOutsidePreparedModelRuntimePluginGenerationScope } from "../../../agents/prepared-model-runtime-generation-scope.js";
import { runOutsidePluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";

/** Drop both inherited generations without dropping the original Gateway caller. */
export function runOutsideAdmittedGenerationScopes<T>(run: () => T): T {
  return runOutsidePreparedModelRuntimePluginGenerationScope(() =>
    runOutsidePluginRuntimeGenerationScope(run),
  );
}
