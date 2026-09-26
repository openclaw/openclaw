// Re-exports plugin modules used by build smoke checks.
export { clearPluginCommands, executePluginCommand, matchPluginCommand } from "./commands.js";
export { getPluginCommandSpecs } from "./command-specs.js";
export { loadOpenClawPlugins, loadPluginRegistryHandle } from "./loader.js";
export { getPluginModuleLoaderStats } from "./plugin-module-loader-cache.js";
export { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";
export {
  buildPluginRuntimeLoadOptions,
  setPluginRuntimeLoadContext,
} from "./runtime/load-context.js";
export { resolvePluginRuntimeLoadContext } from "./runtime/load-context.resolve.js";
