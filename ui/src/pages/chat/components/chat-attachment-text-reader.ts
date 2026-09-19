import { readResponseBytesWithinLimit } from "./chat-response-bytes.ts";

const MAX_BYTES = 256 * 1024;

/** Preview readers share the same bounded, ticket-only text fetch. */
export async function readAttachmentText(
  src: string,
  sizeBytes: number | undefined,
  signal: AbortSignal,
  preview: "full" | "excerpt" = "full",
): Promise<string> {
  const excerpt = preview === "excerpt";
  if (!excerpt && sizeBytes !== undefined && sizeBytes > MAX_BYTES) {
    throw new Error("Text attachment exceeds preview limit");
  }
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), 10_000);
  try {
    const response = await fetch(src, {
      credentials: "same-origin",
      redirect: "error",
      signal: AbortSignal.any([signal, timeoutController.signal]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Text attachment unavailable");
    }
    const bytes = await readResponseBytesWithinLimit(response, MAX_BYTES, { truncate: excerpt });
    if (!bytes) {
      throw new Error("Text attachment exceeds preview limit");
    }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, {
      // An excerpt can end inside a UTF-8 sequence; leave that trailing code point out.
      stream: excerpt,
    });
    if (text.includes("\0")) {
      throw new Error("Binary attachment");
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}
