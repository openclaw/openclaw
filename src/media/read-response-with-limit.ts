export async function readResponseWithLimit(
  res: Response,
  maxBytes: number,
  opts?: {
    onOverflow?: (params: { size: number; maxBytes: number; res: Response }) => Error;
    onSuppressedError?: (params: {
      phase: "cancel_after_overflow" | "release_lock";
      error: unknown;
      res: Response;
    }) => void;
  },
): Promise<Buffer> {
  const onOverflow =
    opts?.onOverflow ??
    ((params: { size: number; maxBytes: number }) =>
      new Error(`Content too large: ${params.size} bytes (limit: ${params.maxBytes} bytes)`));
  const reportSuppressedError = (
    phase: "cancel_after_overflow" | "release_lock",
    error: unknown,
  ) => {
    try {
      opts?.onSuppressedError?.({ phase, error, res });
    } catch {}
  };

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
          try {
            await reader.cancel();
          } catch (error) {
            reportSuppressedError("cancel_after_overflow", error);
          }
          throw onOverflow({ size: total, maxBytes, res });
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (error) {
      reportSuppressedError("release_lock", error);
    }
  }

  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}
