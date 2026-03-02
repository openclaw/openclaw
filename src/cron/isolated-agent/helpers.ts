import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  stripHeartbeatToken,
} from "../../auto-reply/heartbeat.js";
import { truncateUtf16Safe } from "../../utils.js";

type DeliveryPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  channelData?: Record<string, unknown>;
  isError?: boolean;
};

export function pickSummaryFromOutput(text: string | undefined) {
  const clean = (text ?? "").trim();
  if (!clean) {
    return undefined;
  }
  const limit = 2000;
  return clean.length > limit ? `${truncateUtf16Safe(clean, limit)}…` : clean;
}

export function pickSummaryFromPayloads(
  payloads: Array<{ text?: string | undefined; isError?: boolean }>,
) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (payloads[i]?.isError) {
      continue;
    }
    const summary = pickSummaryFromOutput(payloads[i]?.text);
    if (summary) {
      return summary;
    }
  }
  for (let i = payloads.length - 1; i >= 0; i--) {
    const summary = pickSummaryFromOutput(payloads[i]?.text);
    if (summary) {
      return summary;
    }
  }
  return undefined;
}

export function pickLastNonEmptyTextFromPayloads(
  payloads: Array<{ text?: string | undefined; isError?: boolean }>,
) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (payloads[i]?.isError) {
      continue;
    }
    const clean = (payloads[i]?.text ?? "").trim();
    if (clean) {
      return clean;
    }
  }
  for (let i = payloads.length - 1; i >= 0; i--) {
    const clean = (payloads[i]?.text ?? "").trim();
    if (clean) {
      return clean;
    }
  }
  return undefined;
}

export function pickLastDeliverablePayload(payloads: DeliveryPayload[]) {
  const isDeliverable = (p: DeliveryPayload) => {
    const text = (p?.text ?? "").trim();
    const hasMedia = Boolean(p?.mediaUrl) || (p?.mediaUrls?.length ?? 0) > 0;
    const hasChannelData = Object.keys(p?.channelData ?? {}).length > 0;
    return text || hasMedia || hasChannelData;
  };
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (payloads[i]?.isError) {
      continue;
    }
    if (isDeliverable(payloads[i])) {
      return payloads[i];
    }
  }
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (isDeliverable(payloads[i])) {
      return payloads[i];
    }
  }
  return undefined;
}

/**
 * Check if delivery should be skipped because the agent signaled no user-visible update.
 * Returns true when any payload is a heartbeat ack token and no payload contains media.
 */
export function isHeartbeatOnlyResponse(payloads: DeliveryPayload[], ackMaxChars: number) {
  if (payloads.length === 0) {
    return true;
  }
  // If any payload has media, deliver regardless — there's real content.
  const hasAnyMedia = payloads.some(
    (payload) => (payload.mediaUrls?.length ?? 0) > 0 || Boolean(payload.mediaUrl),
  );
  if (hasAnyMedia) {
    return false;
  }
  // An agent may emit multiple text payloads (narration, tool summaries)
  // before a final HEARTBEAT_OK. If *any* payload is a heartbeat ack token,
  // the agent is signaling "nothing needs attention" — the preceding text
  // payloads are just internal narration and should not be delivered.
  return payloads.some((payload) => {
    const result = stripHeartbeatToken(payload.text, {
      mode: "heartbeat",
      maxAckChars: ackMaxChars,
    });
    return result.shouldSkip;
  });
}

export function resolveHeartbeatAckMaxChars(agentCfg?: { heartbeat?: { ackMaxChars?: number } }) {
  const raw = agentCfg?.heartbeat?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
  return Math.max(0, raw);
}
