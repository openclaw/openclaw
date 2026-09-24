// The Telegram "Current message:" block. Split out of inbound-meta.ts so that
// file stays under the line cap. It has two projections: the inline one inside
// the inbound user-context prefix, and the self-contained carrier one.
import type { TemplateContext } from "../templating.js";
import {
  normalizePromptMetadataString,
  sanitizeTranscriptBody,
  sanitizeTranscriptField,
} from "./inbound-meta.text.js";

function isTelegramInboundContext(ctx: TemplateContext): boolean {
  return [ctx.OriginatingChannel, ctx.Surface, ctx.Provider].some(
    (value) => normalizePromptMetadataString(value) === "telegram",
  );
}

function resolveInlineReplyQuote(ctx: TemplateContext): string | undefined {
  return sanitizeTranscriptField(ctx.ReplyToQuoteText) ?? sanitizeTranscriptBody(ctx.ReplyToBody);
}

function formatCurrentMessageBlock(ctx: TemplateContext, stateBody: boolean): string | undefined {
  if (!isTelegramInboundContext(ctx)) {
    return undefined;
  }
  const quote = resolveInlineReplyQuote(ctx);
  if (!quote) {
    return undefined;
  }
  const messageId =
    normalizePromptMetadataString(ctx.MessageSid) ??
    normalizePromptMetadataString(ctx.MessageSidFull);
  const currentBody = stateBody
    ? (sanitizeTranscriptBody(ctx.agentText) ??
      sanitizeTranscriptBody(ctx.BodyForAgent) ??
      sanitizeTranscriptBody(ctx.Body))
    : undefined;
  const header = messageId ? `#${messageId}:${currentBody ? ` ${currentBody}` : ""}` : currentBody;
  return ["Current message:", `[Replying to: ${JSON.stringify(quote)}]`, header]
    .filter((line) => line !== undefined)
    .join("\n");
}

/**
 * Inline projection: a bare "#<id>:" header. Inline consumers (the CLI runner
 * and every other reader of `CurrentInboundPromptContext.text`) join it to the
 * complete, unsanitized user body with the " " prompt joiner, so the header must
 * not restate the body.
 */
export function formatTelegramCurrentMessageContext(ctx: TemplateContext): string | undefined {
  return formatCurrentMessageBlock(ctx, false);
}

/**
 * Carrier projection of the inbound user context. The runtime-context carrier
 * ships as its own model-facing message while the live body arrives as a
 * separate user turn, so no joiner completes the header there. A bare "#<id>:"
 * header is read as an empty/elided current-message body and real instructions
 * get treated as absent or duplicates. The carrier states the canonical body
 * inline instead (sanitized like every other transcript projection; bodyless
 * turns keep the bare header). The block is always the last one in the prefix,
 * so only that trailing block is swapped; any other input is returned unchanged.
 */
export function projectTelegramCurrentMessageCarrier(
  inboundUserContext: string,
  ctx: TemplateContext,
): string {
  const inline = formatCurrentMessageBlock(ctx, false);
  const carrier = formatCurrentMessageBlock(ctx, true);
  if (!inline || !carrier || carrier === inline || !inboundUserContext.endsWith(inline)) {
    return inboundUserContext;
  }
  return `${inboundUserContext.slice(0, inboundUserContext.length - inline.length)}${carrier}`;
}
