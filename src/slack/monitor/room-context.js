import { buildUntrustedChannelMetadata } from "../../security/channel-metadata.js";
export function resolveSlackRoomContextHints(params) {
    if (!params.isRoomish) {
        return {};
    }
    const untrustedChannelMetadata = buildUntrustedChannelMetadata({
        source: "slack",
        label: "Slack channel description",
        entries: [params.channelInfo?.topic, params.channelInfo?.purpose],
    });
    const systemPromptParts = [params.channelConfig?.systemPrompt?.trim() || null].filter((entry) => Boolean(entry));
    const groupSystemPrompt = systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
    return {
        untrustedChannelMetadata,
        groupSystemPrompt,
    };
}
