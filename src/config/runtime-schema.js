import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { collectChannelSchemaMetadata, collectPluginSchemaMetadata, } from "./channel-config-metadata.js";
import { loadConfig, readConfigFileSnapshot } from "./config.js";
import { buildConfigSchema } from "./schema.js";
function loadManifestRegistry(config, env) {
    const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
    return loadPluginManifestRegistry({
        config,
        cache: false,
        env,
        workspaceDir,
    });
}
export function loadGatewayRuntimeConfigSchema() {
    const config = loadConfig();
    const registry = loadManifestRegistry(config);
    return buildConfigSchema({
        plugins: collectPluginSchemaMetadata(registry),
        channels: collectChannelSchemaMetadata(registry),
    });
}
export async function readBestEffortRuntimeConfigSchema() {
    const snapshot = await readConfigFileSnapshot();
    const config = snapshot.valid ? snapshot.config : { plugins: { enabled: true } };
    const registry = loadManifestRegistry(config);
    return buildConfigSchema({
        plugins: snapshot.valid ? collectPluginSchemaMetadata(registry) : [],
        channels: collectChannelSchemaMetadata(registry),
    });
}
