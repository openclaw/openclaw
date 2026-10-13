import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { MessageContentItem, MessageImageSource } from "./chat-types.ts";

function imageDataUrl(data: unknown, mimeType: unknown): string | undefined {
  return typeof data === "string"
    ? data.startsWith("data:")
      ? data
      : `data:${typeof mimeType === "string" ? mimeType : "image/png"};base64,${data}`
    : undefined;
}

export function normalizeImageContentBlock(
  item: Record<string, unknown>,
): Extract<MessageContentItem, { type: "image" }> | undefined {
  const source = asOptionalRecord(item.source);
  if (item.type === "image") {
    const base64Source = source?.type === "base64" && typeof source.data === "string";
    const image: MessageImageSource = {
      url: normalizeOptionalString(item.url) ?? normalizeOptionalString(source?.url),
      dataUrl: imageDataUrl(
        base64Source ? source.data : item.data,
        base64Source ? source.media_type : item.mimeType,
      ),
      preferData: true,
      mimeType: readStringField(item, "mimeType") ?? readStringField(source, "media_type"),
    };
    for (const key of ["artifactId", "fileName", "openUrl", "alt"] as const) {
      const value = readStringField(item, key);
      if (value !== undefined) {
        image[key] = value;
      }
    }
    for (const key of ["sizeBytes", "width", "height"] as const) {
      const value = asFiniteNumber(item[key]);
      if (value !== undefined) {
        image[key] = value;
      }
    }
    return { type: "image", sources: [image], inlineSlot: true };
  }
  if (item.type === "image_url") {
    return {
      type: "image",
      sources: [{ url: normalizeOptionalString(asOptionalRecord(item.image_url)?.url) }],
    };
  }
  if (item.type === "input_image") {
    return {
      type: "image",
      sources: [
        {
          url:
            normalizeOptionalString(item.image_url) ??
            normalizeOptionalString(asOptionalRecord(item.image_url)?.url),
        },
        {
          url: normalizeOptionalString(source?.url),
          dataUrl: imageDataUrl(source?.data, source?.media_type),
          mimeType: readStringField(source, "media_type"),
        },
      ],
    };
  }
  if (item.type === "openclaw_pairing_qr") {
    return {
      type: "image",
      sources: [
        {
          url: normalizeOptionalString(item.image_url),
          alt: readStringField(item, "alt"),
        },
      ],
      expiresAtMs: asFiniteNumber(item.expiresAtMs),
    };
  }
  return undefined;
}
