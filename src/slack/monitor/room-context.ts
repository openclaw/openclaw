import { buildUntrustedChannelMetadata } from "../../security/channel-metadata.js";

export function resolveSlackRoomContextHints(params: {
  isRoomish: boolean;
  channelInfo?: { topic?: string; purpose?: string };
  channelConfig?: { systemPrompt?: string | null } | null;
}): {
  untrustedChannelMetadata?: ReturnType<typeof buildUntrustedChannelMetadata>;
  groupSystemPrompt?: string;
} {
  if (!params.isRoomish) {
    return {};
  }

  const untrustedChannelMetadata = buildUntrustedChannelMetadata({
    source: "slack",
    label: "Slack channel description",
    entries: [params.channelInfo?.topic, params.channelInfo?.purpose],
  });

  const systemPromptParts = [params.channelConfig?.systemPrompt?.trim() || null].filter(
    (entry): entry is string => Boolean(entry),
  );
  const groupSystemPrompt =
    systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;

  return {
    untrustedChannelMetadata,
    groupSystemPrompt,
  };
}
