import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isAbortError } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isRenderablePayload } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

const MAX_VISIBLE_MEMORY_FLUSH_ERROR_CHARS = 600;
const MAX_FLUSH_ERROR_LENGTH = 200;

export function resolveVisibleMemoryFlushErrorPayloads(payloads?: ReplyPayload[]): ReplyPayload[] {
  return (payloads ?? []).filter(
    (payload) => payload.isError === true && isRenderablePayload(payload),
  );
}

export function buildVisibleMemoryFlushFailure(payloads: ReplyPayload[]): Error {
  const message = payloads
    .map((payload) => normalizeOptionalString(payload.text))
    .filter((text): text is string => Boolean(text))
    .join("\n");
  return new Error(message || "Memory flush returned an error response");
}

export function buildMemoryFlushErrorPayload(err: unknown): ReplyPayload | undefined {
  if (isAbortError(err)) {
    return undefined;
  }
  const message = normalizeOptionalString(formatErrorMessage(err));
  if (!message) {
    return undefined;
  }
  const visibleText = message.startsWith("⚠️") ? message : `⚠️ ${message}`;
  return {
    text:
      visibleText.length > MAX_VISIBLE_MEMORY_FLUSH_ERROR_CHARS
        ? `${truncateUtf16Safe(visibleText, MAX_VISIBLE_MEMORY_FLUSH_ERROR_CHARS - 1)}…`
        : visibleText,
    isError: true,
  };
}

export function truncateMemoryFlushErrorMessage(err: unknown): string {
  const message = normalizeOptionalString(formatErrorMessage(err)) || String(err);
  return message.length > MAX_FLUSH_ERROR_LENGTH
    ? `${truncateUtf16Safe(message, MAX_FLUSH_ERROR_LENGTH - 1)}…`
    : message;
}
