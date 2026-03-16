export type ChannelSendRawResult = {
  ok: boolean;
  messageId?: string | null;
  error?: string | null;
};

/** Normalize raw channel send results into the shape shared outbound callers expect. */
export function buildChannelSendResult(channel: string, result: ChannelSendRawResult) {
  return {
    channel,
    ok: result.ok,
    messageId: result.messageId ?? "",
    error: result.error ? new Error(result.error) : undefined,
  };
}
