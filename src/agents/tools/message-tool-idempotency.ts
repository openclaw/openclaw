import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { sha256Base64UrlPrefix } from "../../infra/crypto-digest.js";
import type { GatewayCallOptions } from "./gateway.js";

const MESSAGE_TOOL_IDEMPOTENCY_ENVELOPE_PARAM_KEYS = new Set<string>([
  "gatewayToken",
  "gatewayUrl",
  "idempotencyKey",
  "timeoutMs",
] satisfies Array<keyof GatewayCallOptions | "idempotencyKey">);

function canonicalizeMessageToolIdempotencyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeMessageToolIdempotencyValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  // SAFETY: narrowed by the `typeof value !== "object"` guard above; treat the remaining object as a string-keyed record for canonical ordering.
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).toSorted()) {
    out[key] = canonicalizeMessageToolIdempotencyValue(record[key]);
  }
  return out;
}

export function normalizeMessageToolIdempotencyKeyPart(value: unknown): string | undefined {
  return normalizeOptionalString(value)?.replace(/[^A-Za-z0-9._:-]+/gu, "_");
}

export function buildMessageToolDeliveryFingerprint(params: {
  action: ChannelMessageActionName;
  params: Record<string, unknown>;
}): string {
  const { action, params: input } = params;
  const deliveryParams: Record<string, unknown> = {};
  for (const key of Object.keys(input).toSorted()) {
    if (!MESSAGE_TOOL_IDEMPOTENCY_ENVELOPE_PARAM_KEYS.has(key)) {
      deliveryParams[key] = input[key];
    }
  }
  const canonical = JSON.stringify(
    canonicalizeMessageToolIdempotencyValue({
      action,
      params: deliveryParams,
    }),
  );
  return sha256Base64UrlPrefix(canonical, 24);
}
