export type ChannelSendRawResult = {
  ok: boolean;
  messageId?: string | null;
  error?: string | null;
};

export function buildChannelSendResult(channel: string, result: ChannelSendRawResult) {
  return {
    channel,
    ok: result.ok,
    messageId: result.messageId ?? "",
    error: result.error ? new Error(result.error) : undefined,
  };
}
