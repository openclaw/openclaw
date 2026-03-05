import { formatErrorMessage } from "../infra/errors.js";
import { logDebug } from "../logger.js";

function parseContentLengthHeader(res: Response): number | null {
  const raw = res.headers.get("content-length")?.trim();
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
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

  const declaredSize = parseContentLengthHeader(res);
  if (declaredSize !== null && declaredSize > maxBytes) {
    throw onOverflow({ size: declaredSize, maxBytes, res });
  }

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
          } catch (err) {
            logDebug(
              `media: readResponseWithLimit failed to cancel stream after overflow: ${formatErrorMessage(err)}`,
            );
          }
          throw onOverflow({ size: total, maxBytes, res });
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (err) {
      logDebug(
        `media: readResponseWithLimit failed to release reader lock: ${formatErrorMessage(err)}`,
      );
    }
  }

  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}
