import { vi } from "vitest";
import * as pluginModuleLoader from "../../../plugins/plugin-module-loader-cache.js";

export async function prepareLegacyConfigMigrationRuntime(): Promise<() => void> {
  const bindingRepair = await import("./legacy-config-binding-repair.runtime.js");
  const loadModule = pluginModuleLoader.getCachedPluginModuleLoader;
  // Keep the real migrations in Vitest's graph instead of transforming them
  // again through the synchronous source loader used by Doctor and recovery.
  const moduleLoader = vi
    .spyOn(pluginModuleLoader, "getCachedPluginModuleLoader")
    .mockImplementation((options) =>
      /legacy-config-binding-repair\.runtime\.[jt]s$/u.test(options.modulePath)
        ? () => bindingRepair
        : loadModule(options),
    );
  return () => moduleLoader.mockRestore();
}
