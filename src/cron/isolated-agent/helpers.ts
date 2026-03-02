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
 * Check if payloads should be treated as heartbeat acknowledgements.
 * Returns true when at least one payload is a heartbeat ack token and no media
 * payloads are present. This suppresses noisy narration blocks that may appear
 * before a final HEARTBEAT_OK.
 */
export function isHeartbeatOnlyResponse(payloads: DeliveryPayload[], ackMaxChars: number) {
  if (payloads.length === 0) {
    return true;
  }

  // If there's media or structured channel payload, we should deliver.
  if (
    payloads.some(
      (payload) =>
        (payload.mediaUrls?.length ?? 0) > 0 ||
        Boolean(payload.mediaUrl) ||
        Object.keys(payload.channelData ?? {}).length > 0,
    )
  ) {
    return false;
  }

  let hasHeartbeatAck = false;
  for (const payload of payloads) {
    // Treat only pure HEARTBEAT_OK acknowledgements as suppressors.
    const result = stripHeartbeatToken(payload.text, {
      mode: "message",
      maxAckChars: ackMaxChars,
    });
    if (result.didStrip && result.text === "") {
      hasHeartbeatAck = true;
      break;
    }
  }
  if (hasHeartbeatAck) {
    return true;
  }

  // Preserve existing behavior for empty/whitespace-only payload batches.
  return payloads.every((payload) => !(payload.text ?? "").trim());
}

export function resolveHeartbeatAckMaxChars(agentCfg?: { heartbeat?: { ackMaxChars?: number } }) {
  const raw = agentCfg?.heartbeat?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
  return Math.max(0, raw);
}
