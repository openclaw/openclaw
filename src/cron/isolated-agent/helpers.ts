import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS } from "../../auto-reply/heartbeat.js";
import { stripReasoningTagsFromText } from "../../shared/text/reasoning-tags.js";
import { truncateUtf16Safe } from "../../utils.js";
import { shouldSkipHeartbeatOnlyDelivery } from "../heartbeat-policy.js";

type DeliveryPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  channelData?: Record<string, unknown>;
  isError?: boolean;
  isReasoning?: boolean;
};

export function pickSummaryFromOutput(text: string | undefined) {
  // Strip thinking/reasoning tags so internal model monologue never leaks
  // into user-facing cron announce summaries (#40480).
  const clean = stripReasoningTagsFromText((text ?? "").trim(), {
    mode: "strict",
    trim: "both",
  });
  if (!clean) {
    return undefined;
  }
  const limit = 2000;
  return clean.length > limit ? `${truncateUtf16Safe(clean, limit)}…` : clean;
}

export function pickSummaryFromPayloads(
  payloads: Array<{ text?: string | undefined; isError?: boolean; isReasoning?: boolean }>,
) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (payloads[i]?.isError || payloads[i]?.isReasoning) {
      continue;
    }
    const summary = pickSummaryFromOutput(payloads[i]?.text);
    if (summary) {
      return summary;
    }
  }
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (payloads[i]?.isReasoning) {
      continue;
    }
    const summary = pickSummaryFromOutput(payloads[i]?.text);
    if (summary) {
      return summary;
    }
  }
  return undefined;
}

export function pickLastNonEmptyTextFromPayloads(
  payloads: Array<{ text?: string | undefined; isError?: boolean; isReasoning?: boolean }>,
) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (payloads[i]?.isError || payloads[i]?.isReasoning) {
      continue;
    }
    const clean = (payloads[i]?.text ?? "").trim();
    if (clean) {
      return clean;
    }
  }
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (payloads[i]?.isReasoning) {
      continue;
    }
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
    if (payloads[i]?.isError || payloads[i]?.isReasoning) {
      continue;
    }
    if (isDeliverable(payloads[i])) {
      return payloads[i];
    }
  }
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (payloads[i]?.isReasoning) {
      continue;
    }
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
  return shouldSkipHeartbeatOnlyDelivery(payloads, ackMaxChars);
}

/**
 * Pick the text of the first non-reasoning payload (for fallback summary paths
 * where pickSummaryFromPayloads returned undefined). See Copilot review on #41208.
 */
export function pickFirstNonReasoningText(
  payloads: Array<{ text?: string | undefined; isReasoning?: boolean }>,
): string | undefined {
  for (const p of payloads) {
    if (p?.isReasoning) {
      continue;
    }
    const clean = (p?.text ?? "").trim();
    if (clean) {
      return clean;
    }
  }
  return undefined;
}

export function resolveHeartbeatAckMaxChars(agentCfg?: { heartbeat?: { ackMaxChars?: number } }) {
  const raw = agentCfg?.heartbeat?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
  return Math.max(0, raw);
}
