import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { readStringArrayParam, readStringParam } from "./common.js";

export function hasSanitizedSendPayloadContent(params: Record<string, unknown>): boolean {
  const text = ["message", "text", "content", "caption", "SendMessage"]
    .map((field) => (typeof params[field] === "string" ? params[field] : ""))
    .filter((value) => value.trim())
    .join("\n");
  const mediaUrls = [
    ...(readStringArrayParam(params, "mediaUrls") ?? []),
    ...readStructuredAttachmentMediaParams(params.attachments),
  ];
  return hasReplyPayloadContent(
    {
      text,
      mediaUrl: readFirstStringParam(params, ["media", "mediaUrl", "path", "filePath", "fileUrl"]),
      mediaUrls,
      presentation: params.presentation,
      interactive: params.interactive,
      channelData: params.channelData,
    },
    { trimText: true },
  );
}

function readFirstStringParam(params: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = readStringParam(params, key);
    if (value) {
      return value;
    }
  }
  return "";
}

function readStructuredAttachmentMediaParams(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const values: string[] = [];
  for (const attachment of value) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      continue;
    }
    const record = attachment as Record<string, unknown>;
    for (const key of ["media", "mediaUrl", "path", "filePath", "fileUrl", "url"]) {
      const candidate = readStringParam(record, key);
      if (candidate) {
        values.push(candidate);
      }
    }
  }
  return values;
}
