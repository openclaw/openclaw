import { copyReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { mapArrayIfChanged } from "../../shared/map-array-if-changed.js";
import { stripInternalRuntimeScaffolding } from "./protocol-scaffolding.js";

export function normalizeEmptyPayloadForDelivery(payload: ReplyPayload): ReplyPayload | null {
  const text = typeof payload.text === "string" ? payload.text : "";
  if (text.trim()) {
    return payload;
  }
  if (!hasReplyPayloadContent({ ...payload, text }, { extraContent: payload.location != null })) {
    return null;
  }
  return text ? copyReplyPayloadMetadata(payload, { ...payload, text: "" }) : payload;
}

function stripInternalRuntimeScaffoldingFromValue(value: unknown): unknown {
  if (typeof value === "string") {
    return stripInternalRuntimeScaffolding(value);
  }
  if (Array.isArray(value)) {
    return mapArrayIfChanged(value, stripInternalRuntimeScaffoldingFromValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return value;
  }
  let changed = false;
  const entries = Object.entries(value);
  for (const entry of entries) {
    const stripped = stripInternalRuntimeScaffoldingFromValue(entry[1]);
    changed ||= stripped !== entry[1];
    entry[1] = stripped;
  }
  return changed ? Object.fromEntries(entries) : value;
}

export function stripInternalRuntimeScaffoldingFromPayload(payload: ReplyPayload): ReplyPayload {
  const stripped = stripInternalRuntimeScaffoldingFromValue(payload);
  return stripped !== payload &&
    stripped &&
    typeof stripped === "object" &&
    !Array.isArray(stripped)
    ? copyReplyPayloadMetadata(
        payload,
        // The walker leaves non-plain objects untouched; canonical payload metadata is copied here.
        // SAFETY: Enumerable string-keyed shapes and value kinds are preserved.
        stripped as ReplyPayload,
      )
    : payload;
}
