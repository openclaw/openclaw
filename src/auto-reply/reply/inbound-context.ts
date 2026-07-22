// Builds prompt context facts from inbound channel and sender metadata.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveConversationLabel } from "../../channels/conversation-label.js";
import { resolveCommandTurnContext } from "../command-turn-context.js";
import type { FinalizedMsgContext, MsgContext } from "../templating.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";

export type FinalizeInboundContextOptions = {
  forceBodyForAgent?: boolean;
  forceBodyForCommands?: boolean;
  forceChatType?: boolean;
  forceConversationLabel?: boolean;
};

const DEFAULT_MEDIA_TYPE = "application/octet-stream";

function normalizeTextField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return normalizeInboundTextNewlines(value);
}

function normalizeTrustedTextField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return normalizeInboundTextNewlines(value);
}

function normalizeMediaType(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function countMediaEntries(ctx: MsgContext): number {
  const pathCount = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths.length : 0;
  const urlCount = Array.isArray(ctx.MediaUrls) ? ctx.MediaUrls.length : 0;
  const single = ctx.MediaPath || ctx.MediaUrl ? 1 : 0;
  return Math.max(pathCount, urlCount, single);
}

function foldDeprecatedPromptContextFields(ctx: MsgContext): void {
  // Deprecated SDK field names fold here so third-party channel plugins keep working.
  // Runtime reads only the channel-named fields; remove this with the deprecated fields.
  if (ctx.ChannelPromptContext === undefined && ctx.UntrustedContext !== undefined) {
    ctx.ChannelPromptContext = ctx.UntrustedContext;
  }
  delete ctx.UntrustedContext;
  if (ctx.ChannelStructuredContext === undefined && ctx.UntrustedStructuredContext !== undefined) {
    ctx.ChannelStructuredContext = ctx.UntrustedStructuredContext;
  }
  delete ctx.UntrustedStructuredContext;
}

function applySupplementalContext(ctx: MsgContext): void {
  const supplemental = ctx.SupplementalContext;
  if (!supplemental) {
    return;
  }
  if (
    supplemental.channelStructuredContext === undefined &&
    supplemental.untrustedContext !== undefined
  ) {
    // Fold the deprecated supplemental SDK key before projecting the canonical context shape.
    supplemental.channelStructuredContext = supplemental.untrustedContext;
  }
  delete supplemental.untrustedContext;
  const fields = {
    ReplyToId: supplemental.quote?.id,
    ReplyToIdFull: supplemental.quote?.fullId,
    ReplyToBody: supplemental.quote?.body,
    ReplyToSender: supplemental.quote?.sender,
    ReplyToIsQuote: supplemental.quote?.isQuote,
    ForwardedFrom: supplemental.forwarded?.from,
    ForwardedFromType: supplemental.forwarded?.fromType,
    ForwardedFromId: supplemental.forwarded?.fromId,
    ForwardedDate: supplemental.forwarded?.date,
    ThreadStarterBody: supplemental.thread?.starterBody,
    ThreadHistoryBody: supplemental.thread?.historyBody,
    ThreadLabel: supplemental.thread?.label,
    GroupSystemPrompt: supplemental.groupSystemPrompt,
    ChannelStructuredContext: supplemental.channelStructuredContext,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && ctx[key as keyof MsgContext] === undefined) {
      ctx[key as keyof MsgContext] = value as never;
    }
  }
  delete ctx.SupplementalContext;
}

export function finalizeInboundContext<T extends Record<string, unknown>>(
  ctx: T,
  opts: FinalizeInboundContextOptions = {},
): T & FinalizedMsgContext {
  const normalized = ctx as T & MsgContext;
  foldDeprecatedPromptContextFields(normalized);
  applySupplementalContext(normalized);

  normalized.Body = normalizeInboundTextNewlines(
    typeof normalized.Body === "string" ? normalized.Body : "",
  );
  normalized.RawBody = normalizeTextField(normalized.RawBody);
  normalized.CommandBody = normalizeTextField(normalized.CommandBody);
  normalized.Transcript = normalizeTextField(normalized.Transcript);
  normalized.ThreadStarterBody = normalizeTextField(normalized.ThreadStarterBody);
  normalized.ThreadHistoryBody = normalizeTextField(normalized.ThreadHistoryBody);
  normalized.GroupSystemPrompt = normalizeTrustedTextField(normalized.GroupSystemPrompt);
  if (Array.isArray(normalized.ChannelPromptContext)) {
    const normalizedChannelPromptContext = normalized.ChannelPromptContext.map((entry) =>
      normalizeInboundTextNewlines(entry),
    ).filter((entry) => Boolean(entry));
    normalized.ChannelPromptContext = normalizedChannelPromptContext;
  }

  const chatType = normalizeChatType(normalized.ChatType);
  if (chatType && (opts.forceChatType || normalized.ChatType !== chatType)) {
    normalized.ChatType = chatType;
  }

  const bodyForAgentSource = opts.forceBodyForAgent
    ? normalized.Body
    : (normalized.BodyForAgent ??
      // Prefer "clean" text over legacy envelope-shaped Body when upstream forgets to set BodyForAgent.
      normalized.CommandBody ??
      normalized.RawBody ??
      normalized.Body);
  normalized.BodyForAgent = normalizeInboundTextNewlines(bodyForAgentSource);

  const bodyForCommandsSource = opts.forceBodyForCommands
    ? (normalized.CommandBody ?? normalized.RawBody ?? normalized.Body)
    : (normalized.BodyForCommands ??
      normalized.CommandBody ??
      normalized.RawBody ??
      normalized.Body);
  normalized.BodyForCommands = normalizeInboundTextNewlines(bodyForCommandsSource);

  const explicitLabel = normalizeOptionalString(normalized.ConversationLabel);
  if (opts.forceConversationLabel || !explicitLabel) {
    const resolved = normalizeOptionalString(resolveConversationLabel(normalized));
    if (resolved) {
      normalized.ConversationLabel = resolved;
    }
  } else {
    normalized.ConversationLabel = explicitLabel;
  }

  // Always set. Default-deny when upstream forgets to populate it.
  normalized.CommandAuthorized = normalized.CommandAuthorized === true;
  normalized.CommandTurn = resolveCommandTurnContext(normalized);
  if (normalized.CommandTurn.source === "native" || normalized.CommandTurn.source === "text") {
    normalized.CommandSource = normalized.CommandTurn.source;
    normalized.CommandAuthorized = normalized.CommandTurn.authorized;
  } else {
    normalized.CommandSource = undefined;
  }

  // MediaType/MediaTypes alignment:
  // - No media: do not inject defaults.
  // - Media present: ensure MediaType is always set, and MediaTypes is padded to match
  //   MediaPaths/MediaUrls length when possible.
  const mediaCount = countMediaEntries(normalized);
  if (mediaCount > 0) {
    const mediaType = normalizeMediaType(normalized.MediaType);
    const rawMediaTypes = Array.isArray(normalized.MediaTypes) ? normalized.MediaTypes : undefined;
    const normalizedMediaTypes = rawMediaTypes?.map((entry) => normalizeMediaType(entry));

    let mediaTypesFinal: string[] | undefined;
    if (normalizedMediaTypes && normalizedMediaTypes.length > 0) {
      const filled = normalizedMediaTypes.slice();
      while (filled.length < mediaCount) {
        filled.push(undefined);
      }
      mediaTypesFinal = filled.map((entry) => entry ?? DEFAULT_MEDIA_TYPE);
    } else if (mediaType) {
      mediaTypesFinal = [mediaType];
      while (mediaTypesFinal.length < mediaCount) {
        mediaTypesFinal.push(DEFAULT_MEDIA_TYPE);
      }
    } else {
      mediaTypesFinal = Array.from({ length: mediaCount }, () => DEFAULT_MEDIA_TYPE);
    }

    normalized.MediaTypes = mediaTypesFinal;
    normalized.MediaType = mediaType ?? mediaTypesFinal[0] ?? DEFAULT_MEDIA_TYPE;
  }

  return normalized as T & FinalizedMsgContext;
}
