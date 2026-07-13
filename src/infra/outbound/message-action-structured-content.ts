import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { parseInteractiveParam, parseJsonMessageParam } from "./message-action-params.js";

type VisibleTextSuppressionResult<TReason extends string> = {
  suppressionReason?: TReason;
};

export function parseStructuredMessageContentParams(
  params: Record<string, unknown>,
  options?: { delivery?: boolean },
): void {
  parseJsonMessageParam(params, "presentation");
  parseJsonMessageParam(params, "channelData");
  if (options?.delivery) {
    parseJsonMessageParam(params, "delivery");
  }
  parseInteractiveParam(params);
}

export function readChannelDataObjectParam(
  params: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const rawChannelData = params.channelData;
  return rawChannelData && typeof rawChannelData === "object" && !Array.isArray(rawChannelData)
    ? (rawChannelData as Record<string, unknown>)
    : undefined;
}

export function hasChannelDataPayloadContent(params: Record<string, unknown>): boolean {
  return hasReplyPayloadContent({ channelData: readChannelDataObjectParam(params) });
}

export function sanitizeOpaqueChannelDataParam<TReason extends string>(
  params: Record<string, unknown>,
  bootPrompt: string | undefined,
  sanitizeText: (
    value: string,
    bootPrompt: string | undefined,
  ) => VisibleTextSuppressionResult<TReason>,
): TReason | undefined {
  const suppressionReason = detectOpaqueChannelDataSuppressionReason(
    params.channelData,
    bootPrompt,
    sanitizeText,
  );
  if (suppressionReason) {
    delete params.channelData;
  }
  return suppressionReason;
}

function detectOpaqueChannelDataSuppressionReason<TReason extends string>(
  value: unknown,
  bootPrompt: string | undefined,
  sanitizeText: (
    value: string,
    bootPrompt: string | undefined,
  ) => VisibleTextSuppressionResult<TReason>,
): TReason | undefined {
  if (typeof value === "string") {
    return sanitizeText(value, bootPrompt).suppressionReason;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const reason = detectOpaqueChannelDataSuppressionReason(entry, bootPrompt, sanitizeText);
      if (reason) {
        return reason;
      }
    }
    return undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const keyReason = sanitizeText(key, bootPrompt).suppressionReason;
    if (keyReason) {
      return keyReason;
    }
    const reason = detectOpaqueChannelDataSuppressionReason(entry, bootPrompt, sanitizeText);
    if (reason) {
      return reason;
    }
  }
  return undefined;
}
