import { loadBundledPluginPublicArtifactModuleSync } from "../plugins/public-surface-loader.js";
function loadBundledChannelPublicArtifact(channelId, artifactBasenames) {
    for (const artifactBasename of artifactBasenames) {
        try {
            return loadBundledPluginPublicArtifactModuleSync({
                dirName: channelId,
                artifactBasename,
            });
        }
        catch (error) {
            if (error instanceof Error &&
                error.message.startsWith("Unable to resolve bundled plugin public surface ")) {
                continue;
            }
            if (process.env.OPENCLAW_DEBUG_CHANNEL_CONTRACT_API === "1") {
                const detail = error instanceof Error ? error.message : String(error);
                process.stderr.write(`[channel-contract-api] failed to load ${channelId}/${artifactBasename}: ${detail}\n`);
            }
        }
    }
    return undefined;
}
export function loadBundledChannelSecretContractApi(channelId) {
    return loadBundledChannelPublicArtifact(channelId, ["secret-contract-api.js", "contract-api.js"]);
}
export function loadBundledChannelSecurityContractApi(channelId) {
    return loadBundledChannelPublicArtifact(channelId, ["security-contract-api.js"]);
}
