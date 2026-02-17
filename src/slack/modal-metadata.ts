export type SlackModalPrivateMetadata = {
  sessionKey?: string;
  channelId?: string;
  channelType?: string;
};

const SLACK_PRIVATE_METADATA_MAX = 3000;

function normalizeString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function parseSlackModalPrivateMetadata(raw: unknown): SlackModalPrivateMetadata {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      sessionKey: normalizeString(parsed.sessionKey),
      channelId: normalizeString(parsed.channelId),
      channelType: normalizeString(parsed.channelType),
    };
  } catch {
    return {};
  }
}

export function encodeSlackModalPrivateMetadata(input: SlackModalPrivateMetadata): string {
  const payload: SlackModalPrivateMetadata = {
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...(input.channelType ? { channelType: input.channelType } : {}),
  };
  const encoded = JSON.stringify(payload);
  if (encoded.length > SLACK_PRIVATE_METADATA_MAX) {
    throw new Error(
      `Slack modal private_metadata cannot exceed ${SLACK_PRIVATE_METADATA_MAX} chars`,
    );
  }
  return encoded;
}
