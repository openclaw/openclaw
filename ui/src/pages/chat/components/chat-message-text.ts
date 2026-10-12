import { html } from "lit";
import { guard } from "lit/directives/guard.js";
import { ref } from "lit/directives/ref.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../../../components/icons.ts";
import type { MarkdownJson } from "../../../components/markdown-json.ts";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import { toSanitizedJsonHtml } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { renderMarkdownMedia, type MarkdownMedia } from "./chat-message-media-markdown.ts";
import { messageOverflowRef, shouldCollapseUserMessage } from "./chat-message-overflow.ts";
import {
  prepareMessageMarkdown,
  type DuplicateSuffix,
  type MessageTextOptions,
} from "./chat-message-text-preparation.ts";

registerChatMessageMetadataEnglish();

export function renderMessageJson(
  json: MarkdownJson,
  messageKey: string,
  opts: MessageTextOptions,
  options: MarkdownRenderOptions,
) {
  const parts = [toSanitizedJsonHtml(json, options)];
  const text = html`<div class="chat-text">${unsafeHTML(parts[0])}</div>`;
  return renderMessageDisclosure(json.text, messageKey, opts, text, parts);
}

export function renderMessageMarkdown(
  markdown: string,
  messageKey: string,
  opts: MessageTextOptions,
  markdownRenderOptions: MarkdownRenderOptions,
  duplicateSuffix?: DuplicateSuffix,
  media?: MarkdownMedia,
) {
  const disclosure = opts.assistantMessageDisclosure;
  const { source, parts, recoverFullMessage } = prepareMessageMarkdown(
    markdown,
    messageKey,
    opts,
    markdownRenderOptions,
    duplicateSuffix,
  );
  const content = renderMarkdownMedia({ messageKey, source, parts }, media);
  const text = html`
    <div class="chat-text" dir="${detectTextDirection(media?.text ?? source)}">${content}</div>
  `;
  // Exhausted recovery keeps the preview visible and offers manual re-entry.
  if (recoverFullMessage && disclosure?.onRetryFullMessage) {
    return html`
      ${text}
      <div class="chat-message-load-error">
        ${t("chat.messages.fullContentLoadExhausted")}
        <button
          type="button"
          class="chat-message-load-error__retry"
          @click=${disclosure.onRetryFullMessage}
        >
          ${t("common.retry")}
        </button>
      </div>
    `;
  }
  return renderMessageDisclosure(markdown, messageKey, opts, text, parts);
}

function renderMessageDisclosure(
  source: string,
  messageKey: string,
  opts: MessageTextOptions,
  text: ReturnType<typeof html>,
  parts: readonly string[],
) {
  if (
    !opts.onToggleUserMessageExpanded ||
    (opts.isForwarded
      ? opts.isStreaming
      : opts.role !== "user" || !shouldCollapseUserMessage(source))
  ) {
    return text;
  }

  const disclosureId = `${opts.isForwarded ? "forwarded" : "user"}-message:${messageKey}`;
  const expanded = opts.isUserMessageExpanded?.(disclosureId) ?? false;
  return html`
    <div
      class="chat-message-disclosure ${opts.isForwarded ? "chat-message-disclosure--forwarded" : ""} ${expanded ? "is-expanded" : ""}"
    >
      <div
        class="chat-message-disclosure__content"
        ${guard([...parts, expanded, opts.isForwarded], () =>
          ref(messageOverflowRef(expanded, Boolean(opts.isForwarded))),
        )}
      >
        ${text}
      </div>
      <button
        class="chat-message-disclosure__toggle"
        type="button"
        aria-expanded=${String(expanded)}
        @click=${() => opts.onToggleUserMessageExpanded?.(disclosureId)}
      >
        ${t(expanded ? "chat.messages.showLess" : "chat.messages.showMore")}
        ${expanded ? icons.chevronUp : icons.chevronDown}
      </button>
    </div>
  `;
}
