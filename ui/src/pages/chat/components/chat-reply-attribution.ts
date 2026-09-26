import { html, nothing } from "lit";
import "./chat-attribution.css";
import { ref } from "lit/directives/ref.js";
import { resolveLocalUserName } from "../../../app/user-identity.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { MessageGroup, NormalizedMessage } from "../../../lib/chat/chat-types.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { formatSenderLabel, type SenderIdentity } from "../../../lib/chat/sender-label.ts";
import { persistedMessageEntryId } from "../chat-thread.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import type { ReplyPreview, ReplyPreviewLookup } from "./chat-reply-preview.types.ts";

export type ReplyAttributionPresentation = "hidden" | "full" | "unavailable";

export type ReplyAttribution = {
  presentation: ReplyAttributionPresentation;
  sender: SenderIdentity;
  name: string;
  agentAvatar?: ReplyPreview["agentAvatar"];
  target?: NormalizedMessage["replyTarget"];
  loadedMessageId?: string;
  resolveMessageId?: string;
};

/**
 * The one place that decides whether a reply reference adds context:
 * unresolved references and a 1:1 turn answering its own prompt stay hidden;
 * a confirmed-missing target keeps only a known sender name.
 */
function resolveReplyAttributionPresentation(reply: {
  /** The origin is known: loaded, fetched, or carried by snapshot text. */
  resolved: boolean;
  /** A concrete id whose lookup confirmed the origin is inaccessible. */
  missing: boolean;
  /** A snapshot sender name survives the missing origin. */
  known: boolean;
  /** The origin is the prompt that opened this turn. */
  turnSource: boolean;
  /** More than one person speaks in the conversation. */
  shared: boolean;
}): ReplyAttributionPresentation {
  if (reply.missing) {
    return reply.known ? "unavailable" : "hidden";
  }
  if (!reply.resolved || (reply.turnSource && !reply.shared)) {
    return "hidden";
  }
  return "full";
}

export function isReplyAttributionVisible(
  attribution: ReplyAttribution | undefined,
): attribution is ReplyAttribution {
  return Boolean(attribution && attribution.presentation !== "hidden");
}

type ReplyContext = { shared?: boolean; turnSource?: MessageGroup["replyTurnSource"] };

const hiddenAttribution = (target?: NormalizedMessage["replyTarget"]): ReplyAttribution => ({
  presentation: "hidden",
  sender: {},
  name: "",
  target,
});

function lookupReply(resolveReplyPreview: ReplyPreviewLookup | undefined, id: string) {
  const result = resolveReplyPreview?.(id);
  return result && "missing" in result
    ? { missing: true }
    : { missing: false, preview: result as ReplyPreview | undefined };
}

function resolveTargetAttribution(
  target: Extract<NonNullable<NormalizedMessage["replyTarget"]>, { kind: "id" }>,
  snapshot: NormalizedMessage["replyPreview"],
  lookup: ReturnType<typeof lookupReply>,
  context: ReplyContext = {},
): ReplyAttribution {
  const resolved = lookup.preview;
  const preview = resolved ?? snapshot;
  const name =
    preview?.senderLabel || formatSenderLabel(resolved?.sender) || t("chat.messages.message");
  const presentation = resolveReplyAttributionPresentation({
    resolved: Boolean(resolved || snapshot?.text),
    missing: lookup.missing,
    known: Boolean(snapshot?.senderLabel),
    turnSource: Boolean(
      context.turnSource && persistedMessageEntryId(context.turnSource.message) === target.id,
    ),
    shared: Boolean(context.shared),
  });
  if (presentation === "hidden") {
    return {
      ...hiddenAttribution(target),
      resolveMessageId: !preview?.text && !lookup.missing ? target.id : undefined,
    };
  }
  if (presentation === "unavailable") {
    // Known snapshot facts only: no inferred avatar and nothing to navigate to.
    const known = snapshot?.senderLabel ?? "";
    return { presentation, sender: { name: known }, name: known, target };
  }
  return {
    presentation,
    sender: { ...resolved?.sender, name },
    name,
    agentAvatar: resolved?.agentAvatar,
    target,
    loadedMessageId: resolved?.isLoaded ? target.id : undefined,
    resolveMessageId: !preview?.text ? target.id : undefined,
  };
}

/** Attribution to a transcript row the group already knows (automatic or resolved current). */
function resolveSourceAttribution(
  source: unknown,
  sender: SenderIdentity | undefined,
  resolveReplyPreview: ReplyPreviewLookup | undefined,
): ReplyAttribution | undefined {
  const sourceId = source ? persistedMessageEntryId(source) : null;
  const resolved = sourceId ? lookupReply(resolveReplyPreview, sourceId).preview : undefined;
  const sourceSender = sender ?? resolved?.sender;
  const name = resolved?.senderLabel || formatSenderLabel(sourceSender);
  if (!name) {
    return undefined;
  }
  return {
    presentation: "full",
    sender: { ...sourceSender, name },
    name,
    agentAvatar: resolved?.agentAvatar,
    target: sourceId ? { kind: "id", id: sourceId } : { kind: "current" },
    loadedMessageId: sourceId && resolved?.isLoaded ? sourceId : undefined,
  };
}

export function resolveMessageReplyAttribution(
  message: NormalizedMessage,
  resolveReplyPreview?: ReplyPreviewLookup,
  userId?: string | null,
): ReplyAttribution | undefined {
  const target = message.replyTarget;
  if (!target) {
    return undefined;
  }
  // A bare reply_to_current names no origin outside its turn context.
  if (target.kind === "current") {
    return hiddenAttribution(target);
  }
  const lookup = lookupReply(resolveReplyPreview, target.id);
  const attribution = resolveTargetAttribution(target, message.replyPreview, lookup);
  if (
    attribution.presentation === "full" &&
    attribution.sender.identity?.type === "profile" &&
    attribution.sender.identity.id === userId
  ) {
    attribution.name = resolveLocalUserName();
  }
  return attribution;
}

export function resolveReplyAttribution(
  group: MessageGroup,
  resolveReplyPreview?: ReplyPreviewLookup,
  replyMessages: MessageGroup["messages"] = group.messages,
): ReplyAttribution | undefined {
  if (group.role !== "assistant") {
    return undefined;
  }
  const messages = group.messages.map(({ message }) => normalizeMessage(message));
  const snapshots =
    replyMessages === group.messages
      ? messages
      : replyMessages.map(({ message }) => normalizeMessage(message));
  const context: ReplyContext = { shared: group.replyShared, turnSource: group.replyTurnSource };
  const explicit =
    messages.find((message) => message.replyTarget?.kind === "id") ??
    (messages.some((message) => message.replyTarget?.kind === "current")
      ? undefined
      : snapshots.find((message) => message.replyTarget?.kind === "id"));
  if (explicit?.replyTarget?.kind === "id") {
    const target = explicit.replyTarget;
    const lookup = lookupReply(resolveReplyPreview, target.id);
    const matching = snapshots.filter(
      (message) => message.replyTarget?.kind === "id" && message.replyTarget.id === target.id,
    );
    const snapshot =
      matching.find((message) => message.replyPreview?.text)?.replyPreview ??
      matching.find((message) => message.replyPreview)?.replyPreview;
    return resolveTargetAttribution(target, snapshot, lookup, context);
  }
  const current =
    messages.find((message) => message.replyTarget?.kind === "current") ??
    snapshots.find((message) => message.replyTarget?.kind === "current");
  const currentSource = current ? group.replyCurrentSource : undefined;
  if (currentSource) {
    const attribution = resolveSourceAttribution(
      currentSource.message,
      normalizeMessage(currentSource.message).sender,
      resolveReplyPreview,
    );
    const turnSource = currentSource.key === group.replyTurnSource?.key;
    return attribution && !(turnSource && !group.replyShared)
      ? attribution
      : hiddenAttribution(current?.replyTarget);
  }
  const sender = group.replyToSender;
  if (sender) {
    // Automatic attribution: several people share this thread.
    return resolveSourceAttribution(group.replyToMessage?.message, sender, resolveReplyPreview);
  }
  // An unresolved reply_to_current never guesses its origin.
  return current ? hiddenAttribution(current.replyTarget) : undefined;
}

type ReplyAttributionOptions = {
  variant?: "inline";
  navigationLoading?: boolean;
  navigateToUnloaded?: boolean;
};

export function renderReplyAttribution(
  attribution: ReplyAttribution | undefined,
  onOpenReply?: (id: string) => void,
  onResolveReply?: (id: string) => void,
  options: ReplyAttributionOptions = {},
) {
  if (!attribution) {
    return nothing;
  }
  if (attribution.presentation === "hidden") {
    // Nothing to show yet, but an unresolved id still asks for its origin.
    if (attribution.resolveMessageId) {
      onResolveReply?.(attribution.resolveMessageId);
    }
    return nothing;
  }
  const inline = options.variant === "inline";
  const unavailable = attribution.presentation === "unavailable";
  // Human quotes retain navigation to originals outside the loaded history.
  const sourceId = unavailable
    ? undefined
    : (inline || options.navigateToUnloaded) && attribution.target?.kind === "id"
      ? attribution.target.id
      : attribution.loadedMessageId;
  const person = html`
    ${unavailable ? nothing : renderChatAuthorAvatar(attribution.sender, "chat-author-avatar", attribution.agentAvatar)}
    <span class="chat-reply-attribution__name" title=${attribution.name}>${attribution.name}</span>
  `;
  const resolveMissing = (element?: Element) => {
    if (element && attribution.resolveMessageId) {
      onResolveReply?.(attribution.resolveMessageId);
    }
  };
  return html`<div
    class="chat-reply-attribution ${inline ? "chat-reply-attribution--inline" : "chat-reply-attribution--reply"}"
    ${ref(resolveMissing)}
  >
    <span class="chat-reply-attribution__label"
      >${inline ? nothing : html`<span class="chat-reply-attribution__mobile-icon" aria-hidden="true">${icons.cornerUpLeft}</span>`}${t("chat.messages.replyingToLabel")}</span
    >
    ${
      sourceId && onOpenReply
        ? html`<button
            class="chat-reply-attribution__person chat-reply-attribution__target"
            type="button"
            aria-label=${t("chat.messages.replyingTo", { name: attribution.name })}
            ?disabled=${options.navigationLoading}
            aria-busy=${options.navigationLoading ? "true" : "false"}
            @click=${() => onOpenReply(sourceId)}
          >
            ${person}
          </button>`
        : html`<span class="chat-reply-attribution__person">${person}</span>`
    }
    ${
      unavailable
        ? html`<span class="chat-reply-attribution__unavailable"
            >${t("chat.messages.replyOriginalUnavailable")}</span
          >`
        : nothing
    }
  </div>`;
}
