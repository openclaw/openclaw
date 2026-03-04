import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("media/fetch");

function warnReaderOperationFailed(params: {
  operation: "cancel" | "releaseLock";
  error: unknown;
  maxBytes: number;
  url?: string;
}): void {
  log.warn(`response stream reader ${params.operation} failed`, {
    error: String(params.error),
    maxBytes: params.maxBytes,
    url: params.url || undefined,
  });
}

export async function readResponseWithLimit(
  res: Response,
  maxBytes: number,
  opts?: {
    onOverflow?: (params: { size: number; maxBytes: number; res: Response }) => Error;
  },
): Promise<Buffer> {
  const onOverflow =
    opts?.onOverflow ??
    ((params: { size: number; maxBytes: number }) =>
      new Error(`Content too large: ${params.size} bytes (limit: ${params.maxBytes} bytes)`));

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
            warnReaderOperationFailed({
              operation: "cancel",
              error,
              maxBytes,
              url: res.url,
            });
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
      warnReaderOperationFailed({
        operation: "releaseLock",
        error,
        maxBytes,
        url: res.url,
      });
    }
  }

  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}
