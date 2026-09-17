import { html, nothing } from "lit";
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
import type { ReplyPreview } from "./chat-reply-preview.ts";
import { chatResponsiveLayout } from "./chat-responsive-layout.ts";

export type ReplyAttribution = {
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

function replyAttributionExcerpt(text: string): string {
  return (
    stripMarkdown(text, { stripHtml: true, linkStyle: "label" })
      .split(/\r?\n/)
      .map((candidate) => candidate.replace(/\s+/g, " ").trim())
      .find(Boolean) ?? ""
  );
}

function resolveTargetAttribution(
  target: NonNullable<NormalizedMessage["replyTarget"]>,
  preview: NormalizedMessage["replyPreview"],
  resolved?: ReplyPreview,
): ReplyAttribution {
  const name =
    preview?.senderLabel ||
    formatSenderLabel(resolved?.sender) ||
    t(target.kind === "current" ? "chat.messages.currentMessage" : "chat.messages.message");
  return {
    sender: { ...resolved?.sender, name },
    name,
    text: preview?.text ?? "",
    isAttachment: resolved?.isAttachment,
    isImage: resolved?.isImage,
    agentAvatar: resolved?.agentAvatar,
    target,
    loadedMessageId: target.kind === "id" && resolved?.isLoaded ? target.id : undefined,
    resolveMessageId: target.kind === "id" && !preview?.text ? target.id : undefined,
  };
}

export function resolveMessageReplyAttribution(
  message: NormalizedMessage,
  resolveReplyPreview?: (id: string) => ReplyPreview | undefined,
  userId?: string | null,
): ReplyAttribution | undefined {
  const target = message.replyTarget;
  if (!target) {
    return undefined;
  }
  const resolved = target.kind === "id" ? resolveReplyPreview?.(target.id) : undefined;
  const attribution = resolveTargetAttribution(target, resolved ?? message.replyPreview, resolved);
  if (
    attribution.sender.identity?.type === "profile" &&
    attribution.sender.identity.id === userId
  ) {
    attribution.name = resolveLocalUserName();
  }
  return attribution;
}

export function resolveReplyAttribution(
  group: MessageGroup,
  resolveReplyPreview?: (id: string) => ReplyPreview | undefined,
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
  const explicit =
    messages.find((message) => message.replyTarget?.kind === "id") ??
    (messages.some((message) => message.replyTarget?.kind === "current")
      ? undefined
      : snapshots.find((message) => message.replyTarget?.kind === "id"));
  if (explicit?.replyTarget?.kind === "id") {
    const target = explicit.replyTarget;
    const resolved = resolveReplyPreview?.(target.id);
    const matching = snapshots.filter(
      (message) => message.replyTarget?.kind === "id" && message.replyTarget.id === target.id,
    );
    const preview =
      resolved ??
      matching.find((message) => message.replyPreview?.text)?.replyPreview ??
      matching.find((message) => message.replyPreview)?.replyPreview;
    return resolveTargetAttribution(target, preview, resolved);
  }
  const sender = group.replyToSender;
  if (!sender) {
    const current =
      messages.find((message) => message.replyTarget?.kind === "current") ??
      snapshots.find((message) => message.replyTarget?.kind === "current");
    return current ? resolveMessageReplyAttribution(current, resolveReplyPreview) : undefined;
  }
  const source = group.replyToMessage?.message;
  const sourceId = source ? persistedMessageEntryId(source) : null;
  const resolved = sourceId ? resolveReplyPreview?.(sourceId) : undefined;
  const name = resolved?.senderLabel || formatSenderLabel(sender);
  if (!name) {
    return undefined;
  }
  const prepared = source ? prepareChatMessageRender(source) : undefined;
  const text = prepared
    ? resolveMessageReplyText(source, prepared.normalizedMessage, prepared.displayMarkdown)
    : "";
  return {
    sender: { ...sender, name },
    name,
    text,
    isAttachment: resolved?.isAttachment ?? Boolean(prepared && text && !prepared.displayMarkdown),
    isImage: resolved?.isImage,
    agentAvatar: resolved?.agentAvatar,
    target: sourceId ? { kind: "id", id: sourceId } : { kind: "current" },
    loadedMessageId: sourceId && resolved?.isLoaded ? sourceId : undefined,
  };
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
  const excerpt = replyAttributionExcerpt(attribution.text);
  // Human quotes retain navigation to originals outside the loaded history.
  const sourceId =
    (inline || options.navigateToUnloaded) && attribution.target?.kind === "id"
      ? attribution.target.id
      : attribution.loadedMessageId;
  const accessibleName = t("chat.messages.replyingTo", { name: attribution.name });
  const contents = html`${attribution.isAttachment ? html`<span class="chat-reply-attribution__file" aria-hidden="true">${attribution.isImage ? icons.image : icons.file}</span>` : nothing}<span
      class="chat-reply-attribution__excerpt-text"
      >${excerpt}</span
    >`;
  const person = html`
    ${renderChatAuthorAvatar(attribution.sender, "chat-author-avatar", attribution.agentAvatar)}
    <span class="chat-reply-attribution__name" title=${attribution.name}>${attribution.name}</span>
  `;
  const reference = html`
    ${
      mobile && sourceId && onOpenReply
        ? html`<button
            class="chat-reply-attribution__person chat-reply-attribution__mobile-target"
            type="button"
            aria-label=${accessibleName}
            ?disabled=${options.navigationLoading}
            aria-busy=${options.navigationLoading ? "true" : "false"}
            @click=${() => onOpenReply(sourceId)}
          >
            ${person}
          </button>`
        : html`<span class="chat-reply-attribution__person">${person}</span>`
    }
    ${
      mobile
        ? nothing
        : excerpt
          ? !inline && sourceId && onOpenReply
            ? html`<button
                class="chat-reply-attribution__excerpt"
                type="button"
                aria-label=${accessibleName}
                ?disabled=${options.navigationLoading}
                aria-busy=${options.navigationLoading ? "true" : "false"}
                @click=${() => onOpenReply(sourceId)}
              >
                ${contents}
              </button>`
            : html`<span class="chat-reply-attribution__excerpt">${contents}</span>`
          : html`<span class="chat-reply-attribution__unavailable"
              >${t("chat.messages.replyOriginalUnavailable")}</span
            >`
    }
  `;
  const className = `chat-reply-attribution ${inline ? "chat-reply-attribution--inline" : "chat-reply-attribution--reply"}${excerpt ? "" : " chat-reply-attribution--unavailable"}`;
  const resolveMissing = (element?: Element) => {
    if (element && attribution.resolveMessageId) {
      onResolveReply?.(attribution.resolveMessageId);
    }
  };
  const target = inline
    ? sourceId && onOpenReply && excerpt
      ? html`<button
          class="chat-reply-attribution__target"
          type="button"
          aria-label=${accessibleName}
          ?disabled=${options.navigationLoading}
          aria-busy=${options.navigationLoading ? "true" : "false"}
          @click=${() => onOpenReply(sourceId)}
        >
          ${reference}
        </button>`
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
