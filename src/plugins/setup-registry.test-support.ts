import type { resolvePluginSetupRegistry } from "./setup-registry.js";

export function createEmptyPluginSetupRegistry(): ReturnType<typeof resolvePluginSetupRegistry> {
  return {
    providers: [],
    cliBackends: [],
    configMigrations: [],
    autoEnableProbes: [],
    diagnostics: [],
  };
}
