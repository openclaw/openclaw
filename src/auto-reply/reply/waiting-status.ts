import type { ReplyCompletion } from "../../agents/reply-completion.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

export function buildWaitingStatusPayload(params: {
  completion: ReplyCompletion;
  continuationPending?: boolean;
  yieldAcknowledgment?: string;
  yielded?: boolean;
  hasVisibleMessageDelivery: boolean;
}): ReplyPayload | undefined {
  if (
    params.completion.expectation !== "required" ||
    params.completion.outcome !== "pending" ||
    (!params.yielded && !params.continuationPending) ||
    params.hasVisibleMessageDelivery
  ) {
    return undefined;
  }
  return setReplyPayloadMetadata(
    {
      text:
        params.yieldAcknowledgment?.trim() ||
        "I’m continuing this work and will send the result when it is ready.",
    },
    {
      deliverDespiteSourceReplySuppression: true,
      continuationStatus: true,
    },
  );
}
