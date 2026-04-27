export function resolveMusicGenerationMode(params) {
    return (params.inputImageCount ?? 0) > 0 ? "edit" : "generate";
}
export function listSupportedMusicGenerationModes(provider) {
    const modes = ["generate"];
    const edit = provider.capabilities.edit;
    if (edit?.enabled) {
        modes.push("edit");
    }
    return modes;
}
export function resolveMusicGenerationModeCapabilities(params) {
    const mode = resolveMusicGenerationMode(params);
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
    return {
        mode,
        capabilities: capabilities.edit,
    };
}
