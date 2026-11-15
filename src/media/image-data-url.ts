import { canonicalizeBase64, estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { formatMediaSize } from "./store.shared.js";

/** Decodes a base64 image data URL with optional decoded-size protection. */
export function decodeDataUrl(
  dataUrl: string,
  opts?: { maxBytes?: number },
): {
  buffer: Buffer;
  mimeType: string;
  kind: "image";
} {
  const trimmed = dataUrl.trim();
  // Capturing the full payload can exhaust the RegExp stack before the size guard.
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,/i.exec(trimmed);
  const b64 = match ? trimmed.slice(match[0].length) : "";
  if (!match || !b64 || /[^a-z0-9+/=\r\n]/i.test(b64)) {
    throw new Error("Invalid data URL (expected base64 data: URL).");
  }
  const mimeType = normalizeLowercaseStringOrEmpty(match[1]);
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Unsupported data URL type: ${mimeType || "unknown"}`);
  }
  const estimatedBytes = estimateBase64DecodedBytes(b64);
  if (typeof opts?.maxBytes === "number" && estimatedBytes > opts.maxBytes) {
    // Estimate before decoding so oversized inline payloads do not allocate large buffers.
    throw new Error(
      `Invalid data URL: payload exceeds size limit (${formatMediaSize(estimatedBytes)}, limit ${formatMediaSize(opts.maxBytes)}).`,
    );
  }
  const buffer = Buffer.from(b64, "base64");
  if (buffer.length === 0) {
    throw new Error("Invalid data URL: empty payload.");
  }
  // Buffer.from silently drops truncated tails and re-encodes non-canonical
  // trailing bits; validate through the shared canonicalizer so garbage
  // payloads are rejected here instead of surfacing as unrelated
  // image-processing failures. The canonical dialect keeps the valid
  // missing-padding inputs PR #140226 pinned.
  const payload = canonicalizeBase64(b64);
  const expected = canonicalizeBase64(buffer.toString("base64"));
  if (payload === undefined || payload !== expected) {
    throw new Error("Invalid data URL: base64 payload is truncated or non-canonical.");
  }
  return { buffer, mimeType, kind: "image" };
}
