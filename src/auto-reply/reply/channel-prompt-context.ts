/** Appends channel-supplied prompt context to the user-role body under a marked label. */
import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import type { TemplateContext } from "../templating.js";
import { resolvePromptHistoryLimit } from "./history-limit.js";
import { markInboundContextLabel } from "./inbound-context-marker.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";

/**
 * The fixed marker lets strippers recognize OpenClaw-injected context; it is not
 * a trust guardrail. Trust guidance travels with each entry instead
 * (`buildChannelMetadata` wraps entries in `wrapExternalContent`, whose SECURITY
 * NOTICE carries the do-not-obey clause).
 */
export function appendChannelPromptContext(base: string, channelPromptContext?: string[]): string {
  if (!Array.isArray(channelPromptContext) || channelPromptContext.length === 0) {
    return base;
  }
  const entries = channelPromptContext.map(normalizeInboundTextNewlines).filter(Boolean);
  if (entries.length === 0) {
    return base;
  }
  const header = markInboundContextLabel("Context:");
  const block = [header, ...entries].join("\n");
  return [base, block].filter(Boolean).join("\n\n");
}

export const MAX_CONTEXT_JSON_STRING_CHARS = 2_000;

export function neutralizeMarkdownFences(value: string): string {
  return value.replaceAll("```", "`\u200b``");
}

/** Bounds one string exactly as a context JSON block renders it. */
export function sanitizeContextJsonString(value: string): string {
  return neutralizeMarkdownFences(
    truncateWithMarker(value, MAX_CONTEXT_JSON_STRING_CHARS, {
      marker: "…[truncated]",
      reserve: 14,
      trimEnd: true,
    }),
  );
}

function sanitizeContextJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeContextJsonString(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeContextJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeContextJsonValue(entry)]),
  );
}

export function formatContextJsonBlock(label: string, payload: unknown): string {
  return [label, "```json", JSON.stringify(sanitizeContextJsonValue(payload)), "```"].join("\n");
}

/** Preserve a platform-selected window; legacy pending buffers keep their defensive tail cap. */
export function selectInboundHistoryContext(
  ctx: Pick<TemplateContext, "InboundHistory" | "SessionTranscriptContext">,
) {
  const history = Array.isArray(ctx.InboundHistory) ? ctx.InboundHistory : [];
  const recent = ctx.SessionTranscriptContext?.historyKind === "recent";
  const configuredLimit = ctx.SessionTranscriptContext?.historyLimit;
  const limit =
    recent &&
    typeof configuredLimit === "number" &&
    Number.isSafeInteger(configuredLimit) &&
    configuredLimit >= 0
      ? resolvePromptHistoryLimit(configuredLimit, 20)
      : 20;
  return {
    boundedHistory: limit > 0 ? history.slice(-limit) : [],
    historyLabel: recent ? "Recent chat history:" : "Chat history since last reply:",
    truncated: history.length > limit,
  };
}
