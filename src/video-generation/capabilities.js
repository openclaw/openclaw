export function resolveVideoGenerationMode(params) {
    const inputImageCount = params.inputImageCount ?? 0;
    const inputVideoCount = params.inputVideoCount ?? 0;
    if (inputImageCount > 0 && inputVideoCount > 0) {
        return null;
    }
    if (inputVideoCount > 0) {
        return "videoToVideo";
    }
    if (inputImageCount > 0) {
        return "imageToVideo";
    }
    return "generate";
}
export function listSupportedVideoGenerationModes(provider) {
    const modes = ["generate"];
    const imageToVideo = provider.capabilities.imageToVideo;
    if (imageToVideo?.enabled) {
        modes.push("imageToVideo");
    }
    const videoToVideo = provider.capabilities.videoToVideo;
    if (videoToVideo?.enabled) {
        modes.push("videoToVideo");
    }
    return modes;
}
export function resolveVideoGenerationModeCapabilities(params) {
    const mode = resolveVideoGenerationMode(params);
    const capabilities = params.provider?.capabilities;
    if (!capabilities) {
        return { mode, capabilities: undefined };
    }
    if (mode === "generate") {
        return {
            mode,
            capabilities: capabilities.generate,
        };
    }
    if (mode === "imageToVideo") {
        return {
            mode,
            capabilities: capabilities.imageToVideo,
        };
    }
    if (mode === "videoToVideo") {
        return {
            mode,
            capabilities: capabilities.videoToVideo,
        };
    }
    return {
        mode,
        capabilities: undefined,
    };
}
