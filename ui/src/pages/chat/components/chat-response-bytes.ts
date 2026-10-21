import { consumeResponseBytes } from "@openclaw/normalization-core";

export async function readResponseBytesWithinLimit(
  response: Response,
  maxBytes: number,
  options: { truncate?: boolean } = {},
): Promise<ArrayBuffer | null> {
  const contentLengthHeader = response.headers.get("Content-Length");
  const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
  if (
    !options.truncate &&
    contentLength !== undefined &&
    Number.isFinite(contentLength) &&
    contentLength > maxBytes
  ) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return null;
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    const result = await consumeResponseBytes({
      maxBytes,
      stopAtLimit: options.truncate,
      skipEmptyChunks: false,
      read: () => reader.read(),
      onChunk: (chunk) => {
        chunks.push(chunk);
        totalBytes += chunk.byteLength;
      },
      onLimit: () => reader.cancel().catch(() => undefined),
    });
    if (result.truncated && !options.truncate) {
      return null;
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}
