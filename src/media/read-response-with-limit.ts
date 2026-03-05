export async function readResponseWithLimit(
  res: Response,
  maxBytes: number,
  opts?: {
    onOverflow?: (params: {
      size: number;
      maxBytes: number;
      res: Response;
      cancelError?: unknown;
    }) => Error;
  },
): Promise<Buffer> {
  const onOverflow =
    opts?.onOverflow ??
    ((params: { size: number; maxBytes: number; cancelError?: unknown }) => {
      const message = `Content too large: ${params.size} bytes (limit: ${params.maxBytes} bytes)`;
      if (!params.cancelError) {
        return new Error(message);
      }
      return new Error(
        `${message}; additionally failed to cancel response stream: ${String(params.cancelError)}`,
      );
    });

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
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value?.length) {
        total += value.length;
        if (total > maxBytes) {
          let cancelError: unknown;
          try {
            await reader.cancel();
          } catch (err) {
            cancelError = err;
          }
          throw onOverflow({ size: total, maxBytes, res, cancelError });
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
