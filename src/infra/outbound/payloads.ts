import type { ReplyPayload } from "../../auto-reply/types.js";

export type NormalizedOutboundPayload = {
  text: string;
  mediaUrls: string[];
};

export type OutboundPayloadJson = {
  text: string;
  mediaUrl: string | null;
  mediaUrls?: string[];
};

export function normalizeOutboundPayloads(payloads: ReplyPayload[]): NormalizedOutboundPayload[] {
  return payloads
    .map((payload) => ({
      text: payload.text ?? "",
      mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []),
    }))
    .filter((payload) => payload.text || payload.mediaUrls.length > 0);
}

export function normalizeOutboundPayloadsForJson(payloads: ReplyPayload[]): OutboundPayloadJson[] {
  return payloads.map((payload) => ({
    text: payload.text ?? "",
    mediaUrl: payload.mediaUrl ?? null,
    mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : undefined),
  }));
}

export function formatOutboundPayloadLog(payload: NormalizedOutboundPayload): string {
  const lines: string[] = [];
  if (payload.text) lines.push(payload.text.trimEnd());
  for (const url of payload.mediaUrls) lines.push(`MEDIA:${url}`);
  return lines.join("\n");
}
