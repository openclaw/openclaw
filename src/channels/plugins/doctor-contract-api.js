import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
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
        }
    }
    return undefined;
}
export function loadBundledChannelDoctorContractApi(channelId) {
    return loadBundledChannelPublicArtifact(channelId, ["doctor-contract-api.js", "contract-api.js"]);
}
