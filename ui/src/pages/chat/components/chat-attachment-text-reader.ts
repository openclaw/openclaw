import { CANVAS_DOCUMENT_PREVIEW_MAX_BYTES } from "../../../../../packages/gateway-protocol/src/canvas-limits.js";
import { readResponseBytesWithinLimit } from "./chat-response-bytes.ts";

export const TEXT_ATTACHMENT_PREVIEW_MAX_BYTES = 256 * 1024;

/** Preview readers share the same bounded, ticket-only text fetch. */
export async function readAttachmentText(
  src: string,
  sizeBytes: number | undefined,
  signal: AbortSignal,
  preview: "full" | "excerpt" | "html" = "full",
): Promise<string> {
  const excerpt = preview === "excerpt";
  const maxBytes =
    preview === "html" ? CANVAS_DOCUMENT_PREVIEW_MAX_BYTES : TEXT_ATTACHMENT_PREVIEW_MAX_BYTES;
  if (!excerpt && sizeBytes !== undefined && sizeBytes > maxBytes) {
    throw new Error("Text attachment exceeds preview limit");
  }
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), 10_000);
  const combinedSignal = AbortSignal.any([signal, timeoutController.signal]);
  // Node's bundled fetch crashes the process when a data: response is aborted after
  // delivery but before its body is consumed: the data-scheme path builds the body
  // without the stream controller its abort handler dereferences. A data: body is
  // already local, so settle cancellation around the read instead of handing the
  // signal to fetch.
  const isDataUrl = src.startsWith("data:");
  try {
    const response = await fetch(src, {
      credentials: "same-origin",
      redirect: "error",
      signal: isDataUrl ? undefined : combinedSignal,
    });
    if (isDataUrl && combinedSignal.aborted) {
      await response.body?.cancel().catch(() => undefined);
      throw combinedSignal.reason;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Text attachment unavailable");
    }
    const bytes = await readResponseBytesWithinLimit(response, maxBytes, { truncate: excerpt });
    if (isDataUrl && combinedSignal.aborted) {
      throw combinedSignal.reason;
    }
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
