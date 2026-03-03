import { firstDefined } from "./bot-access.js";
export function resolveTelegramGroupPromptSettings(params) {
    const skillFilter = firstDefined(params.topicConfig?.skills, params.groupConfig?.skills);
    const systemPromptParts = [
        params.groupConfig?.systemPrompt?.trim() || null,
        params.topicConfig?.systemPrompt?.trim() || null,
    ].filter((entry) => Boolean(entry));
    const groupSystemPrompt = systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
    return { skillFilter, groupSystemPrompt };
}
