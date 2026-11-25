import { vi } from "vitest";
import * as nativeModuleRequire from "../../../plugins/native-module-require.js";

export async function prepareLegacyConfigMigrationRuntime(): Promise<() => void> {
  const bindingRepair = await import("./legacy-config-binding-repair.runtime.js");
  const loadModule = nativeModuleRequire.tryNativeRequireModule;
  // Keep unit-test migrations in Vitest's graph so their existing module mocks apply.
  const moduleLoader = vi
    .spyOn(nativeModuleRequire, "tryNativeRequireModule")
    .mockImplementation((modulePath, options) =>
      /legacy-config-binding-repair\.runtime\.[jt]s$/u.test(modulePath)
        ? { ok: true, moduleExport: bindingRepair }
        : loadModule(modulePath, options),
    );
  return () => moduleLoader.mockRestore();
}
