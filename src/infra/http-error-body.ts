import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

export async function readResponseBodySnippet(
  response: Response,
  limits: { maxBytes: number; maxChars: number },
): Promise<string> {
  try {
    const body = response.body;
    if (!body || typeof body.getReader !== "function") {
      const text = await response.text();
      const encoded = new TextEncoder().encode(text);
      if (encoded.byteLength > limits.maxBytes) {
        return truncateUtf16Safe(
          new TextDecoder().decode(encoded.subarray(0, limits.maxBytes), {
            stream: true,
          }),
          limits.maxChars,
        );
      }
      return truncateUtf16Safe(text, limits.maxChars);
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
      new TextDecoder().decode(Buffer.concat(chunks, total)),
      limits.maxChars,
    );
  } catch {
    return "";
  }
}
