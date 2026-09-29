// Detached queue drains re-admit on the generation current at drain time.
import { runOutsidePreparedModelRuntimePluginGenerationScope } from "../../../agents/prepared-model-runtime-generation-scope.js";
import { runOutsidePluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";

/**
 * Runs a detached drain outside the scheduling turn's prepared-generation and
 * plugin runtime generation scopes, so a parked turn never inherits the
 * predecessor run's replaced generation or resolves providers through its
 * retired plugin registry.
 */
export function runOutsideAdmittedGenerationScopes<T>(run: () => T): T {
  return runOutsidePreparedModelRuntimePluginGenerationScope(() =>
    runOutsidePluginRuntimeGenerationScope(run),
  );
}
