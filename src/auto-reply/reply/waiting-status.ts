import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

export function buildWaitingStatusPayload(params: {
  yielded: boolean;
  continuationPending?: boolean;
  yieldAcknowledgment?: string;
  isInteractive: boolean;
  isHeartbeat?: boolean;
  silentExpected?: boolean;
  isSubagentSession: boolean;
  hasExplicitSilentReply: boolean;
  hasVisibleMessageDelivery: boolean;
}): ReplyPayload | undefined {
  if (
    (!params.yielded && !params.continuationPending) ||
    !params.isInteractive ||
    params.isHeartbeat === true ||
    params.silentExpected === true ||
    params.isSubagentSession ||
    params.hasExplicitSilentReply ||
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
