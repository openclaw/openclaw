// Shared guard for browser-provided Talk relay audio frames.
import { canonicalizeBase64 } from "@openclaw/media-core/base64";

export function decodeTalkRelayAudioBase64(base64: string, label: string): Buffer {
  const canonicalBase64 = canonicalizeBase64(base64);
  if (!canonicalBase64) {
    throw new Error(`${label} audio frame is invalid base64`);
  }
  return Buffer.from(canonicalBase64, "base64");
}
