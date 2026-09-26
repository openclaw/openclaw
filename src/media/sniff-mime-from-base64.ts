// Base64 mime sniffing helpers infer media types from encoded payload bytes.
import { inspectBase64, type Base64Facts } from "@openclaw/media-core/base64";
import { detectMime } from "@openclaw/media-core/mime";

const BASE64_SNIFF_PREFIX_CHARS = 256;

/** Validates the whole payload unless facts are prepared; only MIME decoding is prefix-bounded. */
export async function sniffMimeFromBase64(
  base64: string | (Base64Facts & { buffer?: Buffer }),
  hints: Pick<
    Parameters<typeof detectMime>[0],
    "headerMime" | "filePath" | "additionalMimeHints"
  > = {},
): Promise<string | undefined> {
  const facts = typeof base64 === "string" ? inspectBase64(base64, "canonical") : base64;
  if (!facts?.canonicalPadBits) {
    return undefined;
  }

  const take = Math.min(BASE64_SNIFF_PREFIX_CHARS, facts.base64.length);
  const sliceLength = take - (take % 4);
  // Keep the existing minimum so short magic-byte prefixes are not treated as complete media.
  const decoded = typeof base64 === "string" ? undefined : base64.buffer;
  const head =
    sliceLength < 8
      ? undefined
      : (decoded?.subarray(0, (sliceLength / 4) * 3) ??
        Buffer.from(facts.base64.slice(0, sliceLength), "base64"));
  return await detectMime({ ...hints, buffer: head });
}
