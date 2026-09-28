// Reserve room for the chat.send JSON envelope and message text before
// accounting for base64's 4/3 expansion.
const WS_FRAME_ENVELOPE_SLACK_BYTES = 256 * 1024;

export function resolveChatAttachmentFrameBudgetBytes(maxPayloadBytes: number): number {
  return Math.max(0, Math.floor(((maxPayloadBytes - WS_FRAME_ENVELOPE_SLACK_BYTES) * 3) / 4));
}
