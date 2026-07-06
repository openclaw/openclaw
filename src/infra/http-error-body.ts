import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

export async function readResponseBodySnippet(
  response: Response,
  limits: { maxBytes: number; maxChars: number },
): Promise<string> {
  try {
    const body = response.body;
    if (!body || typeof body.getReader !== "function") {
      const text =
        await /* boundary-safety-ignore boundary/response-body-limit: no stream exists; enforce maxBytes after fallback. */ response.text();
      const encoded = new TextEncoder().encode(text);
      const byteLimitedText =
        encoded.byteLength > limits.maxBytes
          ? new TextDecoder().decode(encoded.subarray(0, limits.maxBytes), { stream: true })
          : text;
      return truncateUtf16Safe(byteLimitedText, limits.maxChars);
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || !value?.byteLength) {
          break;
        }
        const remaining = limits.maxBytes - total;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
          truncated = true;
          break;
        }
        chunks.push(value);
        total += value.byteLength;
        if (total >= limits.maxBytes) {
          truncated = true;
          break;
        }
      }
    } finally {
      if (truncated) {
        await reader.cancel().catch(() => undefined);
      }
      try {
        reader.releaseLock();
      } catch {}
    }

    return truncateUtf16Safe(
      new TextDecoder().decode(Buffer.concat(chunks, total), { stream: true }),
      limits.maxChars,
    );
  } catch {
    return "";
  }
}
