import { selectLongerFinalText } from "../../channels/streaming.js";
import type { PartialReplyPayload } from "../get-reply-options.types.js";
import { copyReplyPayloadMetadata, type ReplyPayload } from "../reply-payload.js";

/** Holds preview text back while modifiers decide the canonical final payload. */
export function createBufferedPreDeliveryProgress(enabled: boolean) {
  let latestPartial: PartialReplyPayload | undefined;

  return {
    observePartial: (payload: PartialReplyPayload): void => {
      if (enabled) {
        latestPartial = payload;
      }
    },
    reset: (): void => {
      latestPartial = undefined;
    },
    recoverFinalReplies: (replies: ReplyPayload[]): ReplyPayload[] => {
      if (!enabled) {
        return replies;
      }
      const bufferedText = latestPartial?.text?.trimEnd();
      if (!bufferedText) {
        return replies;
      }
      const textRecoveries = replies.flatMap((reply, index) => {
        if (!reply.text) {
          return [];
        }
        const recoveredText = selectLongerFinalText({
          finalText: reply.text,
          candidateTexts: [bufferedText],
        });
        return recoveredText ? [{ index, text: recoveredText }] : [];
      });
      const [recovery] = textRecoveries;
      if (textRecoveries.length === 1 && recovery) {
        return replies.map((reply, index) =>
          index === recovery.index
            ? copyReplyPayloadMetadata(reply, { ...reply, text: recovery.text })
            : reply,
        );
      }
      const [reply] = replies;
      if (replies.length === 1 && reply && !reply.text) {
        return [copyReplyPayloadMetadata(reply, { ...reply, text: bufferedText })];
      }
      return replies;
    },
  };
}
