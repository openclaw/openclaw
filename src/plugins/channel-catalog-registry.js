import { discoverOpenClawPlugins } from "./discovery.js";
import { loadPluginManifest, } from "./manifest.js";
export function listChannelCatalogEntries(params = {}) {
    return discoverOpenClawPlugins({
        workspaceDir: params.workspaceDir,
        env: params.env,
    }).candidates.flatMap((candidate) => {
        if (params.origin && candidate.origin !== params.origin) {
            return [];
        }
        const channel = candidate.packageManifest?.channel;
        if (!channel?.id) {
            return [];
        }
        const manifest = loadPluginManifest(candidate.rootDir, candidate.origin !== "bundled");
        if (!manifest.ok) {
            return [];
        }
        return [
            {
                pluginId: manifest.manifest.id,
                origin: candidate.origin,
                packageName: candidate.packageName,
                workspaceDir: candidate.workspaceDir,
                rootDir: candidate.rootDir,
                channel,
                ...(candidate.packageManifest?.install
                    ? { install: candidate.packageManifest.install }
                    : {}),
            },
        ];
    });
}
