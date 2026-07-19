import { decodeTextPrefix } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatErrorMessage } from "./errors.js";
import { readResponseTextPrefix } from "./http-body.js";

const errorBodyLog = createSubsystemLogger("http-error-body");

/**
 * Wraps a body-less `Response` (e.g. one whose underlying body has already
 * been consumed by a cache, mock, or fetch variant that does not expose a
 * stream) in a cancelable `ReadableStream`. The wrapper is intentionally
 * cancelable so the shared `readResponseTextPrefix` helper can stop reading
 * and discard pending chunked output once it has seen `maxBytes` bytes, even
 * though the body-less response itself cannot be cancelled at the transport
 * layer. The pre-allocated encoded buffer is therefore only materialized
 * when a consumer actually drains the stream, and only the bytes that the
 * consumer reads are kept alive in the returned string.
 */
function wrapBodylessResponseAsStream(response: Response): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) {
        controller.close();
        return;
      }
      let text: string;
      try {
        text = await response.text();
      } catch (err) {
        controller.error(err);
        return;
      }
      if (cancelled) {
        controller.close();
        return;
      }
      if (text.length === 0) {
        controller.close();
        return;
      }
      const CHUNK = 16 * 1024;
      for (let i = 0; i < text.length; i += CHUNK) {
        if (cancelled) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(text.slice(i, i + CHUNK)));
      }
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
}

export async function readResponseBodySnippet(
  response: Response,
  limits: { maxBytes: number; maxChars: number },
): Promise<string> {
  try {
    const body = response.body;
    if (!body || typeof body.getReader !== "function") {
      // 1) Pre-check Content-Length so an oversized declared body is
      // rejected without ever materializing it through response.text().
      const declared = response.headers.get("content-length");
      if (declared !== null) {
        const parsed = Number.parseInt(declared, 10);
        if (Number.isFinite(parsed) && parsed > limits.maxBytes) {
          return truncateUtf16Safe(
            decodeTextPrefix(Buffer.alloc(0), { truncated: true }),
            limits.maxChars,
          );
        }
      }
      // 2) Wrap the body-less response in a cancelable stream so the shared
      // readResponseTextPrefix helper can stop the read at limits.maxBytes.
      // The wrapper's cancel() callback prevents any further chunked output
      // from being produced once the limit is reached.
      const wrapped = new Response(wrapBodylessResponseAsStream(response), {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
      const prefix = await readResponseTextPrefix(wrapped, limits.maxBytes);
      return truncateUtf16Safe(prefix.text, limits.maxChars);
    }

    const prefix = await readResponseTextPrefix(response, limits.maxBytes);
    return truncateUtf16Safe(prefix.text, limits.maxChars);
  } catch (err) {
    errorBodyLog.warn(`Failed to read response body snippet: ${formatErrorMessage(err)}`);
    return "";
  }
}