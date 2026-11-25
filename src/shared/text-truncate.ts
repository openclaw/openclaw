import {
  sliceUtf16Safe,
  truncateUtf16Safe,
  truncateWithMarker,
} from "@openclaw/normalization-core/utf16-slice";

export function truncateOptionalText(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? truncateUtf16Safe(trimmed, maxLength) : undefined;
}

export function truncateUtf16WithEllipsis(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 1) {
    return truncateUtf16Safe(value, maxLength);
  }
  return truncateWithMarker(value, maxLength, { marker: "…", reserve: 1, trimEnd: false });
}

/** Compacts normalized text; callers can reuse their bounded character prefix. */
export function compactProgressText(
  text: string,
  maxChars: number,
  chars = Array.from(sliceUtf16Safe(text, 0, (Math.max(0, maxChars) + 1) * 2)),
): string {
  if (chars.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return "…";
  }
  // Include the first omitted code point so a complete final word is retained.
  const boundary = chars.slice(0, maxChars).findLastIndex((char) => /\s/u.test(char));
  const end = boundary > Math.floor(maxChars * 0.6) ? boundary : maxChars - 1;
  return `${chars.slice(0, end).join("").trimEnd()}…`;
}
