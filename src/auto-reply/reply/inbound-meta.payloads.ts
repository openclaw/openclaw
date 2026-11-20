import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TemplateContext } from "../templating.js";
import { normalizePromptMetadataString, sanitizePromptBody } from "./inbound-meta.text.js";

export function buildLocationContextPayload(
  ctx: TemplateContext,
): Record<string, unknown> | undefined {
  const payload = {
    latitude: ctx.LocationLat,
    longitude: ctx.LocationLon,
    accuracy_m:
      ctx.LocationAccuracy !== undefined && Number.isFinite(ctx.LocationAccuracy)
        ? ctx.LocationAccuracy
        : undefined,
    source: normalizePromptMetadataString(ctx.LocationSource),
    is_live: ctx.LocationIsLive === true ? true : undefined,
    name: sanitizePromptBody(ctx.LocationName),
    address: sanitizePromptBody(ctx.LocationAddress),
    caption: sanitizePromptBody(ctx.LocationCaption),
  };
  return Object.values(payload).some((value) => value !== undefined) ? payload : undefined;
}

export function buildInboundHistoryMediaPromptPayload(
  value: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const payload = {
      kind: normalizePromptMetadataString(entry["kind"]),
      content_type: normalizePromptMetadataString(entry["contentType"]),
      message_id: normalizePromptMetadataString(entry["messageId"]),
      has_local_path: normalizePromptMetadataString(entry["path"]) ? true : undefined,
      has_url: normalizePromptMetadataString(entry["url"]) ? true : undefined,
    };
    return Object.values(payload).some((field) => field !== undefined) ? [payload] : [];
  });
}
