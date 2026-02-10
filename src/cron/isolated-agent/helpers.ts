import AjvModule, { type ErrorObject } from "ajv";
import addFormatsModule from "ajv-formats";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  stripHeartbeatToken,
} from "../../auto-reply/heartbeat.js";
import { truncateUtf16Safe } from "../../utils.js";

const AjvCtor = (AjvModule as unknown as { default?: typeof AjvModule }).default ?? AjvModule;
const ajv = new (AjvCtor as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
  coerceTypes: false,
});
const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule })
  .default ?? addFormatsModule) as (ajv: unknown) => void;
addFormats(ajv);

type DeliveryPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  channelData?: Record<string, unknown>;
};

export function pickSummaryFromOutput(text: string | undefined) {
  const clean = (text ?? "").trim();
  if (!clean) {
    return undefined;
  }
  const limit = 2000;
  return clean.length > limit ? `${truncateUtf16Safe(clean, limit)}…` : clean;
}

export function pickSummaryFromPayloads(payloads: Array<{ text?: string | undefined }>) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    const summary = pickSummaryFromOutput(payloads[i]?.text);
    if (summary) {
      return summary;
    }
  }
  return undefined;
}

export function pickLastNonEmptyTextFromPayloads(payloads: Array<{ text?: string | undefined }>) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    const clean = (payloads[i]?.text ?? "").trim();
    if (clean) {
      return clean;
    }
  }
  return undefined;
}

export function pickLastDeliverablePayload(payloads: DeliveryPayload[]) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    const payload = payloads[i];
    const text = (payload?.text ?? "").trim();
    const hasMedia = Boolean(payload?.mediaUrl) || (payload?.mediaUrls?.length ?? 0) > 0;
    const hasChannelData = Object.keys(payload?.channelData ?? {}).length > 0;
    if (text || hasMedia || hasChannelData) {
      return payload;
    }
  }
  return undefined;
}

/**
 * Check if all payloads are just heartbeat ack responses (HEARTBEAT_OK).
 * Returns true if delivery should be skipped because there's no real content.
 */
export function isHeartbeatOnlyResponse(payloads: DeliveryPayload[], ackMaxChars: number) {
  if (payloads.length === 0) {
    return true;
  }
  return payloads.every((payload) => {
    // If there's media, we should deliver regardless of text content.
    const hasMedia = (payload.mediaUrls?.length ?? 0) > 0 || Boolean(payload.mediaUrl);
    if (hasMedia) {
      return false;
    }
    // Use heartbeat mode to check if text is just HEARTBEAT_OK or short ack.
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

/**
 * Try to extract a JSON object or array from text that may contain
 * markdown fences or surrounding prose.
 */
export function extractJsonFromText(text: string): string | null {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed;
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }

  const braceStart = trimmed.indexOf("{");
  const bracketStart = trimmed.indexOf("[");
  const start =
    braceStart === -1
      ? bracketStart
      : bracketStart === -1
        ? braceStart
        : Math.min(braceStart, bracketStart);
  if (start === -1) {
    return null;
  }
  const opener = trimmed[start];
  const closer = opener === "{" ? "}" : "]";
  const lastClose = trimmed.lastIndexOf(closer);
  if (lastClose <= start) {
    return null;
  }
  return trimmed.slice(start, lastClose + 1);
}

/**
 * Validate a JSON string against a JSON Schema.
 */
export function validateJsonSchema(
  jsonString: string,
  schema: Record<string, unknown>,
): { valid: true; data: unknown } | { valid: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    return { valid: false, error: `JSON parse error: ${String(err)}` };
  }

  const validate = ajv.compile(schema);
  if (validate(parsed)) {
    return { valid: true, data: parsed };
  }
  const errors =
    validate.errors
      ?.map((err: ErrorObject) => {
        const missing = (err.params as { missingProperty?: string }).missingProperty;
        const path = err.instancePath || missing || "root";
        return `${path}: ${err.message}`;
      })
      .join("; ") ?? "Unknown validation error";
  return { valid: false, error: `Schema validation failed: ${errors}` };
}
