import { loadOpenClawPlugins } from "../loader.js";
import { hasExplicitPluginIdScope } from "../plugin-scope.js";
import { buildPluginRuntimeLoadOptions, resolvePluginRuntimeLoadContext } from "./load-context.js";
export function loadPluginMetadataRegistrySnapshot(options) {
    const context = resolvePluginRuntimeLoadContext(options);
    return loadOpenClawPlugins(buildPluginRuntimeLoadOptions(context, {
        throwOnLoadError: true,
        cache: false,
        activate: false,
        mode: "validate",
        loadModules: options?.loadModules,
        ...(hasExplicitPluginIdScope(options?.onlyPluginIds)
            ? { onlyPluginIds: options?.onlyPluginIds }
            : {}),
    }));
}
