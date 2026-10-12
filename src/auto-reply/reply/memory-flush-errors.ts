import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../../infra/errors.js";
import { truncateUtf16WithEllipsis } from "../../shared/text-truncate.js";
import { isRenderablePayload } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

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

export function truncateMemoryFlushErrorMessage(err: unknown): string {
  const message = normalizeOptionalString(formatErrorMessage(err)) || String(err);
  return truncateUtf16WithEllipsis(message, MAX_FLUSH_ERROR_LENGTH);
}
