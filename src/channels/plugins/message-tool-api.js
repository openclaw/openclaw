import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
const MESSAGE_TOOL_API_ARTIFACT_BASENAME = "message-tool-api.js";
const MISSING_PUBLIC_SURFACE_PREFIX = "Unable to resolve bundled plugin public surface ";
const messageToolApiCache = new Map();
function loadBundledChannelMessageToolApi(channelId) {
    const cacheKey = channelId.trim();
    if (messageToolApiCache.has(cacheKey)) {
        return messageToolApiCache.get(cacheKey);
    }
    try {
        const loaded = loadBundledPluginPublicArtifactModuleSync({
            dirName: cacheKey,
            artifactBasename: MESSAGE_TOOL_API_ARTIFACT_BASENAME,
        });
        messageToolApiCache.set(cacheKey, loaded);
        return loaded;
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith(MISSING_PUBLIC_SURFACE_PREFIX)) {
            messageToolApiCache.set(cacheKey, undefined);
            return undefined;
        }
        throw error;
    }
}
export function resolveBundledChannelMessageToolDiscoveryAdapter(channelId) {
    const describeMessageTool = loadBundledChannelMessageToolApi(channelId)?.describeMessageTool;
    if (typeof describeMessageTool !== "function") {
        return undefined;
    }
    return { describeMessageTool };
}
export function describeBundledChannelMessageTool(params) {
    const describeMessageTool = loadBundledChannelMessageToolApi(params.channelId)?.describeMessageTool;
    if (typeof describeMessageTool !== "function") {
        return undefined;
    }
    return describeMessageTool(params.context) ?? null;
}
export const __testing = {
    clearMessageToolApiCache: () => messageToolApiCache.clear(),
};
