import { resolveManifestCommandAliasOwnerInRegistry, } from "./manifest-command-aliases.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
export function resolveManifestCommandAliasOwner(params) {
    const registry = params.registry ??
        loadPluginManifestRegistry({
            config: params.config,
            workspaceDir: params.workspaceDir,
            env: params.env,
        });
    return resolveManifestCommandAliasOwnerInRegistry({
        command: params.command,
        registry,
    });
}
