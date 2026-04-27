import { listSupportedMusicGenerationModes } from "../../music-generation/capabilities.js";
import { listRuntimeMusicGenerationProviders } from "../../music-generation/runtime.js";
import { buildMusicGenerationTaskStatusDetails, buildMusicGenerationTaskStatusText, findActiveMusicGenerationTaskForSession, } from "../music-generation-task-status.js";
import { createMediaGenerateProviderListActionResult, createMediaGenerateTaskStatusActions, } from "./media-generate-tool-actions-shared.js";
function summarizeMusicGenerationCapabilities(provider) {
    const supportedModes = listSupportedMusicGenerationModes(provider);
    const generate = provider.capabilities.generate;
    const edit = provider.capabilities.edit;
    const capabilities = [
        supportedModes.length > 0 ? `modes=${supportedModes.join("/")}` : null,
        generate?.maxTracks ? `maxTracks=${generate.maxTracks}` : null,
        edit?.maxInputImages ? `maxInputImages=${edit.maxInputImages}` : null,
        generate?.maxDurationSeconds ? `maxDurationSeconds=${generate.maxDurationSeconds}` : null,
        generate?.supportsLyrics ? "lyrics" : null,
        generate?.supportsInstrumental ? "instrumental" : null,
        generate?.supportsDuration ? "duration" : null,
        generate?.supportsFormat ? "format" : null,
        generate?.supportedFormats?.length
            ? `supportedFormats=${generate.supportedFormats.join("/")}`
            : null,
        generate?.supportedFormatsByModel && Object.keys(generate.supportedFormatsByModel).length > 0
            ? `supportedFormatsByModel=${Object.entries(generate.supportedFormatsByModel)
                .map(([modelId, formats]) => `${modelId}:${formats.join("/")}`)
                .join("; ")}`
            : null,
    ]
        .filter((entry) => Boolean(entry))
        .join(", ");
    return capabilities;
}
export function createMusicGenerateListActionResult(config) {
    const providers = listRuntimeMusicGenerationProviders({ config });
    return createMediaGenerateProviderListActionResult({
        providers,
        emptyText: "No music-generation providers are registered.",
        listModes: listSupportedMusicGenerationModes,
        summarizeCapabilities: summarizeMusicGenerationCapabilities,
    });
}
const musicGenerateTaskStatusActions = createMediaGenerateTaskStatusActions({
    inactiveText: "No active music generation task is currently running for this session.",
    findActiveTask: (sessionKey) => findActiveMusicGenerationTaskForSession(sessionKey) ?? undefined,
    buildStatusText: buildMusicGenerationTaskStatusText,
    buildStatusDetails: buildMusicGenerationTaskStatusDetails,
});
export function createMusicGenerateStatusActionResult(sessionKey) {
    return musicGenerateTaskStatusActions.createStatusActionResult(sessionKey);
}
export function createMusicGenerateDuplicateGuardResult(sessionKey) {
    return musicGenerateTaskStatusActions.createDuplicateGuardResult(sessionKey);
}
