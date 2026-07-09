import { Buffer } from "node:buffer";

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/**
 * Returns the number of leading bytes of `bytes` that form a sequence of complete
 * UTF-8 characters, up to `maxBytes`. Drops any trailing partial multibyte sequence
 * (a dangling lead byte or its missing continuation bytes) so decoding the result
 * never yields a trailing U+FFFD. Handles both a hard byte cap and an input Buffer
 * that was already byte-sliced mid-sequence upstream.
 */
function completeUtf8PrefixLength(bytes: Buffer, maxBytes: number): number {
  const end = Math.min(maxBytes, bytes.byteLength);
  if (end <= 0) {
    return 0;
  }
  // Walk back from the last byte to the lead of its multibyte sequence, then verify
  // the full sequence is present within [0, end). If the trailing sequence is cut
  // off, drop it so decoding does not produce a trailing U+FFFD.
  let leadIndex = end - 1;
  while (leadIndex > 0 && isContinuationByte(bytes[leadIndex])) {
    leadIndex -= 1;
  }
  const lead = bytes[leadIndex];
  if (lead < 0x80) {
    // ASCII byte at leadIndex; everything up to end is complete.
    return end;
  }
  let expected: number;
  if (lead >= 0xc0 && lead < 0xe0) {
    expected = 2;
  } else if (lead < 0xf0) {
    expected = 3;
  } else if (lead < 0xf8) {
    expected = 4;
  } else {
    // Invalid lead byte; drop everything from leadIndex onward.
    return leadIndex;
  }
  if (leadIndex + expected <= end) {
    return end;
  }
  // Trailing sequence is incomplete; cut at the lead byte.
  return leadIndex;
}

/** Keeps the longest UTF-8 prefix that fits within the byte limit. */
export function truncateUtf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  return bytes.subarray(0, completeUtf8PrefixLength(bytes, maxBytes)).toString("utf8");
}

/**
 * Decodes only the byte-bounded UTF-8 prefix of a Buffer, trimming any trailing
 * partial multibyte sequence so the result never ends in U+FFFD. Use this over
 * `truncateUtf8Prefix(buffer.toString("utf8"), maxBytes)` when the source Buffer
 * may be much larger than the preview, to avoid decoding the whole payload.
 */
export function truncateUtf8PrefixFromBuffer(value: Buffer, maxBytes: number): string {
  if (maxBytes <= 0 || value.byteLength === 0) {
    return "";
  }
  return value.subarray(0, completeUtf8PrefixLength(value, maxBytes)).toString("utf8");
}

/** Keeps the longest UTF-8 suffix that fits within the byte limit. */
export function truncateUtf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && isContinuationByte(bytes[start])) {
    start += 1;
  }
  return bytes.subarray(start).toString("utf8");
}
