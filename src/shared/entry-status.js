import { resolveEmojiAndHomepage } from "./entry-metadata.js";
import { evaluateRequirementsFromMetadataWithRemote, } from "./requirements.js";
export function evaluateEntryMetadataRequirements(params) {
    const { emoji, homepage } = resolveEmojiAndHomepage({
        metadata: params.metadata,
        frontmatter: params.frontmatter,
    });
    const { required, missing, eligible, configChecks } = evaluateRequirementsFromMetadataWithRemote({
        always: params.always,
        metadata: params.metadata ?? undefined,
        hasLocalBin: params.hasLocalBin,
        localPlatform: params.localPlatform,
        remote: params.remote,
        isEnvSatisfied: params.isEnvSatisfied,
        isConfigSatisfied: params.isConfigSatisfied,
    });
    return {
        ...(emoji ? { emoji } : {}),
        ...(homepage ? { homepage } : {}),
        required,
        missing,
        requirementsSatisfied: eligible,
        configChecks,
    };
}
export function evaluateEntryMetadataRequirementsForCurrentPlatform(params) {
    return evaluateEntryMetadataRequirements({
        ...params,
        localPlatform: process.platform,
    });
}
export function evaluateEntryRequirementsForCurrentPlatform(params) {
    return evaluateEntryMetadataRequirementsForCurrentPlatform({
        always: params.always,
        metadata: params.entry.metadata,
        frontmatter: params.entry.frontmatter,
        hasLocalBin: params.hasLocalBin,
        remote: params.remote,
        isEnvSatisfied: params.isEnvSatisfied,
        isConfigSatisfied: params.isConfigSatisfied,
    });
}
