// Base64 mime sniffing helpers infer media types from encoded payload bytes.
import { canonicalizeBase64 } from "@openclaw/media-core/base64";
import { detectMime } from "@openclaw/media-core/mime";

const BASE64_SNIFF_PREFIX_CHARS = 256;

/** Sniffs a MIME type from a small base64 prefix after validating the full payload. */
export async function sniffMimeFromBase64(base64: string): Promise<string | undefined> {
  const canonical = canonicalizeBase64(base64);
  if (!canonical) {
    return undefined;
  }

  try {
    const canonicalPrefix = canonical.slice(
      0,
      BASE64_SNIFF_PREFIX_CHARS - (BASE64_SNIFF_PREFIX_CHARS % 4),
    );
    const head = Buffer.from(canonicalPrefix, "base64");
    return await detectMime({ buffer: head });
  } catch {
    return undefined;
  }
}
