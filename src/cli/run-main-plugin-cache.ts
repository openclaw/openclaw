import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { pluginSourceCaptureMaintenance } from "../plugins/plugin-source-capture-context.js";
import { withCliCommandCleanup, type CliHarnessCleanup } from "./runtime-cleanup-scope.js";

/** Executable commands own their inventory until Gateway publication adopts it. */
export async function withCliPluginInvocation<T>(
  gatewayRun: boolean,
  run: (cleanup?: CliHarnessCleanup) => T | Promise<T>,
): Promise<T> {
  return await withCliCommandCleanup(gatewayRun, async (cleanup) => {
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
    const invoke = () => withPluginCache(cache, () => run(cleanup));
    if (!cleanup?.pluginResources) {
      return invoke();
    }
    const resources = cleanup.pluginResources;
    return pluginSourceCaptureMaintenance.run(
      { scheduler: cleanup.scheduler, run: (operation) => resources.run(operation) },
      invoke,
    );
  });
}
