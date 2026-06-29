export async function readResponseBodySnippet(
  response: Response,
  limits: { maxBytes: number; maxChars: number },
): Promise<string> {
  try {
    const body = response.body;
    if (!body || typeof body.getReader !== "function") {
      return (await response.text()).slice(0, limits.maxChars);
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
      } catch { /* reader already released or stream closed during abort */ }
    }

    return new TextDecoder().decode(Buffer.concat(chunks, total)).slice(0, limits.maxChars);
  } catch {
    return "";
  }
}
