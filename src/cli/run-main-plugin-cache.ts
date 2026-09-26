import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { withCliCommandCleanup, type CliHarnessCleanup } from "./runtime-cleanup-scope.js";

/** Executable commands own their inventory until Gateway publication adopts it. */
export function withCliPluginInvocation<T>(
  gatewayRun: boolean,
  run: (cleanup?: CliHarnessCleanup) => T,
): T {
  return withCliCommandCleanup(gatewayRun, (cleanup) => {
    if (gatewayRun) {
      return run();
    }
    const cache = createPluginCache();
    cleanup?.pluginResources?.adopt({
      async release() {
        // Gateway publication transfers the same inventory to process custody.
        if (cache.kind === "operation") {
          const result = await retirePluginCache(cache);
          if (result.failures.length > 0) {
            throw new AggregateError(
              result.failures.map((failure) => failure.error),
              "CLI plugin inventory cleanup failed",
            );
          }
        }
      },
    });
    return withPluginCache(cache, () => run(cleanup));
  });
}
