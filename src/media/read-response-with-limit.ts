/** Default per-chunk read timeout: 30 seconds. */
const DEFAULT_CHUNK_TIMEOUT_MS = 30_000;

export async function readResponseWithLimit(
  res: Response,
  maxBytes: number,
  opts?: {
    onOverflow?: (params: { size: number; maxBytes: number; res: Response }) => Error;
    /** Maximum time (ms) to wait for a single chunk before aborting.
     *  Prevents the read loop from hanging indefinitely when a download stalls. */
    chunkTimeoutMs?: number;
  },
): Promise<Buffer> {
  const onOverflow =
    opts?.onOverflow ??
    ((params: { size: number; maxBytes: number }) =>
      new Error(`Content too large: ${params.size} bytes (limit: ${params.maxBytes} bytes)`));
  const chunkTimeout = opts?.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS;

  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    const fallback = Buffer.from(await res.arrayBuffer());
    if (fallback.length > maxBytes) {
      throw onOverflow({ size: fallback.length, maxBytes, res });
    }
    return fallback;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunkResult = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Media download stalled: no data received for ${chunkTimeout}ms`)),
            chunkTimeout,
          ),
        ),
      ]);
      const { done, value } = chunkResult;
      if (done) {
        break;
      }
      if (value?.length) {
        total += value.length;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {}
          throw onOverflow({ size: total, maxBytes, res });
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}
