import { stripHeartbeatToken } from "../auto-reply/heartbeat.js";

export type HeartbeatDeliveryPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
};

export function shouldSkipHeartbeatOnlyDelivery(
  payloads: HeartbeatDeliveryPayload[],
  ackMaxChars: number,
  ackToken?: string,
): boolean {
  if (payloads.length === 0) {
    return true;
  }
  const hasAnyMedia = payloads.some(
    (payload) => (payload.mediaUrls?.length ?? 0) > 0 || Boolean(payload.mediaUrl),
  );
  if (hasAnyMedia) {
    return false;
  }
  return payloads.some((payload) => {
    const result = stripHeartbeatToken(payload.text, {
      mode: "heartbeat",
      maxAckChars: ackMaxChars,
      ackToken,
    });
    return result.shouldSkip;
  });
}

export function shouldEnqueueCronMainSummary(params: {
  summaryText: string | undefined;
  deliveryRequested: boolean;
  delivered: boolean | undefined;
  deliveryAttempted: boolean | undefined;
  suppressMainSummary: boolean;
  isCronSystemEvent: (text: string) => boolean;
}): boolean {
  const summaryText = params.summaryText?.trim();
  return Boolean(
    summaryText &&
    params.isCronSystemEvent(summaryText) &&
    params.deliveryRequested &&
    !params.delivered &&
    params.deliveryAttempted !== true &&
    !params.suppressMainSummary,
  );
}
