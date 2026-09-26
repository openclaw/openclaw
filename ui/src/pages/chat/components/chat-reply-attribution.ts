import { html, nothing, type TemplateResult } from "lit";
import "./chat-attribution.css";
import { ref } from "lit/directives/ref.js";
import { stripMarkdown } from "../../../../../src/shared/text/strip-markdown.js";
import { resolveLocalUserName } from "../../../app/user-identity.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { MessageGroup, NormalizedMessage } from "../../../lib/chat/chat-types.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { formatSenderLabel, type SenderIdentity } from "../../../lib/chat/sender-label.ts";
import { persistedMessageEntryId } from "../chat-thread.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import { prepareChatMessageRender, resolveMessageReplyText } from "./chat-message-markdown.ts";
import type { ReplyPreview, ReplyPreviewLookup } from "./chat-reply-preview.types.ts";
import { chatResponsiveLayout } from "./chat-responsive-layout.ts";

export type ReplyAttributionPresentation = "hidden" | "full" | "unavailable";

export type ReplyAttribution = {
  presentation: ReplyAttributionPresentation;
  sender: SenderIdentity;
  name: string;
  text: string;
  isAttachment?: boolean;
  isImage?: boolean;
  agentAvatar?: ReplyPreview["agentAvatar"];
  target?: NormalizedMessage["replyTarget"];
  loadedMessageId?: string;
  resolveMessageId?: string;
};

/**
 * The one place that decides whether a reply reference adds context:
 * unresolved references and a 1:1 turn answering its own prompt stay hidden;
 * a confirmed-missing target keeps only a known name or excerpt.
 */
export function resolveReplyAttributionPresentation(reply: {
  /** The origin is known: loaded, fetched, or carried by a snapshot excerpt. */
  resolved: boolean;
  /** A concrete id whose lookup confirmed the origin is inaccessible. */
  missing: boolean;
  /** A snapshot name or excerpt survives the missing origin. */
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
  text: "",
  target,
});

function lookupReply(resolveReplyPreview: ReplyPreviewLookup | undefined, id: string) {
  const result = resolveReplyPreview?.(id);
  return result && "missing" in result
    ? { missing: true }
    : { missing: false, preview: result as ReplyPreview | undefined };
}

function replyAttributionExcerpt(text: string): string {
  return (
    stripMarkdown(text, { stripHtml: true, linkStyle: "label" })
      .split(/\r?\n/)
      .map((candidate) => candidate.replace(/\s+/g, " ").trim())
      .find(Boolean) ?? ""
  );
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
    known: Boolean(snapshot?.senderLabel || snapshot?.text),
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
    const known = snapshot?.senderLabel || t("chat.messages.message");
    return {
      presentation,
      sender: { name: known },
      name: known,
      text: snapshot?.text ?? "",
      target,
    };
  }
  return {
    presentation,
    sender: { ...resolved?.sender, name },
    name,
    text: preview?.text ?? "",
    isAttachment: resolved?.isAttachment,
    isImage: resolved?.isImage,
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
  const prepared = source ? prepareChatMessageRender(source) : undefined;
  const text = prepared
    ? resolveMessageReplyText(source, prepared.normalizedMessage, prepared.displayMarkdown)
    : "";
  return {
    presentation: "full",
    sender: { ...sourceSender, name },
    name,
    text,
    isAttachment: resolved?.isAttachment ?? Boolean(prepared && text && !prepared.displayMarkdown),
    isImage: resolved?.isImage,
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

function inlineReplyTargetRef(onResolve: (element?: Element) => void) {
  let observer: ResizeObserver | undefined;
  let current: Element | undefined;
  return (element: Element | undefined) => {
    observer?.disconnect();
    current = element;
    onResolve(element);
    if (!element) {
      return;
    }
    queueMicrotask(() => {
      if (current !== element || !element.isConnected) {
        return;
      }
      const target = element.querySelector<HTMLButtonElement>(
        "button.chat-reply-attribution__target",
      );
      if (!target) {
        return;
      }
      const update = () => {
        // The excerpt does not size short bubbles. Cap the hit area to its
        // visible contents after the bubble has allocated their available width.
        target.style.maxWidth = "";
        target.style.columnGap = "";
        const content = [
          ...target.querySelectorAll<HTMLElement>(
            ".chat-reply-attribution__person, .chat-reply-attribution__file, .chat-reply-attribution__excerpt-text",
          ),
        ]
          .map((item) => item.getBoundingClientRect())
          .filter((bounds) => bounds.width > 0);
        if (content.length === 1) {
          target.style.columnGap = "0px";
        }
        if (content.length) {
          const width =
            Math.max(...content.map((bounds) => bounds.right)) -
            Math.min(...content.map((bounds) => bounds.left));
          const style = getComputedStyle(target);
          target.style.maxWidth = `${width + Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)}px`;
        }
      };
      update();
      if (typeof ResizeObserver === "function") {
        observer = new ResizeObserver(update);
        observer.observe(element);
        const messages = element.closest(".chat-group-messages");
        if (messages) {
          observer.observe(messages);
        }
      }
    });
  };
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
  return options.variant === "inline"
    ? renderReplyAttributionContent(attribution, onOpenReply, onResolveReply, options, false)
    : chatResponsiveLayout((mobile) =>
        renderReplyAttributionContent(attribution, onOpenReply, onResolveReply, options, mobile),
      );
}

function renderReplyAttributionContent(
  attribution: ReplyAttribution,
  onOpenReply: ((id: string) => void) | undefined,
  onResolveReply: ((id: string) => void) | undefined,
  options: ReplyAttributionOptions,
  mobile: boolean,
) {
  const inline = options.variant === "inline";
  const unavailable = attribution.presentation === "unavailable";
  const excerpt = replyAttributionExcerpt(attribution.text);
  // Human quotes retain navigation to originals outside the loaded history.
  const sourceId = unavailable
    ? undefined
    : (inline || options.navigateToUnloaded) && attribution.target?.kind === "id"
      ? attribution.target.id
      : attribution.loadedMessageId;
  const accessibleName = t("chat.messages.replyingTo", { name: attribution.name });
  const button = (className: string, content: TemplateResult) => html`<button
    class=${className}
    type="button"
    aria-label=${accessibleName}
    ?disabled=${options.navigationLoading}
    aria-busy=${options.navigationLoading ? "true" : "false"}
    @click=${() => sourceId && onOpenReply?.(sourceId)}
  >
    ${content}
  </button>`;
  const contents = html`${attribution.isAttachment ? html`<span class="chat-reply-attribution__file" aria-hidden="true">${attribution.isImage ? icons.image : icons.file}</span>` : nothing}<span
      class="chat-reply-attribution__excerpt-text"
      >${excerpt}</span
    >`;
  const person = html`
    ${unavailable ? nothing : renderChatAuthorAvatar(attribution.sender, "chat-author-avatar", attribution.agentAvatar)}
    <span class="chat-reply-attribution__name" title=${attribution.name}>${attribution.name}</span>
  `;
  const reference = html`
    ${
      mobile && sourceId && onOpenReply
        ? button("chat-reply-attribution__person chat-reply-attribution__mobile-target", person)
        : html`<span class="chat-reply-attribution__person">${person}</span>`
    }
    ${
      mobile
        ? nothing
        : html`${
            excerpt
              ? !inline && sourceId && onOpenReply
                ? button("chat-reply-attribution__excerpt", contents)
                : html`<span class="chat-reply-attribution__excerpt">${contents}</span>`
              : nothing
          }${
            unavailable
              ? html`<span class="chat-reply-attribution__unavailable"
                  >${t("chat.messages.replyOriginalUnavailable")}</span
                >`
              : nothing
          }`
    }
  `;
  const className = `chat-reply-attribution ${inline ? "chat-reply-attribution--inline" : "chat-reply-attribution--reply"}`;
  const resolveMissing = (element?: Element) => {
    if (element && attribution.resolveMessageId) {
      onResolveReply?.(attribution.resolveMessageId);
    }
  };
  const target = inline
    ? sourceId && onOpenReply && excerpt
      ? button("chat-reply-attribution__target", reference)
      : html`<span class="chat-reply-attribution__target">${reference}</span>`
    : reference;
  return html`<div
    class=${className}
    ${ref(inline ? inlineReplyTargetRef(resolveMissing) : resolveMissing)}
  >
    <span class="chat-reply-attribution__label"
      >${inline ? nothing : html`<span class="chat-reply-attribution__mobile-icon" aria-hidden="true">${icons.cornerUpLeft}</span>`}${t("chat.messages.replyingToLabel")}</span
    >
    ${target}
  </div>`;
}
