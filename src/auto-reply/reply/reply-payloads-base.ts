import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyToMode } from "../../config/types.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import {
  copyReplyPayloadMetadata,
  isRenderablePayload,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload, ReplyThreadingPolicy } from "../types.js";
import {
  createReplyToModeFilterForChannel,
  resolveImplicitCurrentMessageReplyAllowance,
} from "./reply-threading.js";

export function applyReplyTagsToPayload(params: {
  payload: ReplyPayload;
  replyToMode?: ReplyToMode;
  implicitReplyToId?: string;
  currentMessageId?: string;
  replyThreading?: ReplyThreadingPolicy;
}): ReplyPayload {
  const payload = normalizeOptionalString(params.payload.replyToId)
    ? setReplyPayloadMetadata(copyReplyPayloadMetadata(params.payload, { ...params.payload }), {
        replyToIdExplicit: true,
      })
    : params.payload;
  const implicitReplyToId = normalizeOptionalString(params.implicitReplyToId);
  const currentMessageId = normalizeOptionalString(params.currentMessageId);
  const allowImplicitReplyToCurrentMessage = resolveImplicitCurrentMessageReplyAllowance(
    params.replyToMode,
    params.replyThreading,
  );

  let resolved: ReplyPayload =
    payload.replyToId ||
    payload.replyToCurrent === false ||
    !implicitReplyToId ||
    !allowImplicitReplyToCurrentMessage
      ? payload
      : copyReplyPayloadMetadata(payload, {
          ...payload,
          replyToId: implicitReplyToId,
        });

  // Inline reply tags override implicit threading without losing payload metadata.
  if (typeof resolved.text === "string" && resolved.text.includes("[[")) {
    const tags = parseInlineDirectives(resolved.text, {
      currentMessageId,
      stripAudioTag: false,
    });
    resolved = copyReplyPayloadMetadata(resolved, {
      ...resolved,
      text: tags.text ? tags.text : undefined,
      replyToId: tags.replyToId ?? resolved.replyToId,
      replyToTag: tags.hasReplyTag || resolved.replyToTag,
      replyToCurrent: tags.replyToCurrent || resolved.replyToCurrent,
    });
  }

  if (resolved.replyToCurrent && !resolved.replyToId && currentMessageId) {
    resolved = copyReplyPayloadMetadata(resolved, {
      ...resolved,
      replyToId: currentMessageId,
    });
  }

  return resolved;
}

type ReplyThreadingParams = {
  payloads: ReplyPayload[];
  replyToMode: ReplyToMode;
  replyToChannel?: OriginatingChannelType;
  currentMessageId?: string;
  replyThreading?: ReplyThreadingPolicy;
};

/** Resolves reply targets and filters empty payloads before channel delivery. */
export function resolveReplyThreadingPayloads(params: ReplyThreadingParams): ReplyPayload[] {
  const { payloads, replyToMode, currentMessageId, replyThreading } = params;
  const implicitReplyToId = normalizeOptionalString(currentMessageId);
  return payloads
    .map((payload) =>
      applyReplyTagsToPayload({
        payload,
        replyToMode,
        implicitReplyToId,
        currentMessageId,
        replyThreading,
      }),
    )
    .filter(isRenderablePayload);
}

/** Applies threading policy and filters empty payloads before channel delivery. */
export function applyReplyThreading(params: ReplyThreadingParams): ReplyPayload[] {
  const applyReplyToMode = createReplyToModeFilterForChannel(
    params.replyToMode,
    params.replyToChannel,
  );
  return resolveReplyThreadingPayloads(params).map(applyReplyToMode);
}
