import { bytesToBase64 } from "../../../lib/bytes-base64.ts";

export function encodeTextAsDataUrl(text: string): string {
  return `data:text/plain;base64,${bytesToBase64(new TextEncoder().encode(text))}`;
}
