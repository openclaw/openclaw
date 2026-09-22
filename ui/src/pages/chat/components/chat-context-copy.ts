import { readMarkdownCodeBlockCopyText } from "../../../components/markdown-code-blocks.ts";
import { markdownTableCopyText } from "../../../components/markdown-tables.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";

registerChatMessageMetadataEnglish();

export function usesNativeContextMenu(path: EventTarget[]): boolean {
  return path.some(
    (target) =>
      target instanceof Element &&
      (target.matches("a, img, audio, video, iframe, input, textarea, select") ||
        (target instanceof HTMLElement &&
          (target.isContentEditable ||
            target.getAttribute("contenteditable") === "true" ||
            target.getAttribute("contenteditable") === "plaintext-only" ||
            target.getAttribute("contenteditable") === ""))),
  );
}

/** Read the clicked content's existing copy payload, never sibling content or playback blobs. */
export function resolveChatContextCopy(target: Element): { label: string; text: string } | null {
  const codeBlock = target.closest(".code-block-wrapper");
  const codeCopy = codeBlock?.querySelector<HTMLElement>(".code-block-copy");
  if (codeCopy) {
    return { label: t("common.copyCode"), text: readMarkdownCodeBlockCopyText(codeCopy) };
  }
  const code = target.closest("pre, code");
  if (code) {
    return { label: t("common.copyCode"), text: code.textContent ?? "" };
  }
  const table =
    target.closest("table") ?? target.closest(".markdown-table")?.querySelector("table");
  if (table instanceof HTMLTableElement) {
    return { label: t("common.copyTable"), text: markdownTableCopyText(table) };
  }
  const attachment = target.closest(".chat-assistant-attachment-card, .chat-attachment-file");
  if (attachment) {
    // The download owner has already resolved admission and the current media ticket.
    // Inner media src can instead point at a transient decoded playback buffer.
    const link = attachment.querySelector<HTMLAnchorElement>(
      "a.chat-assistant-attachment-card__download[href]:not([aria-disabled='true'])",
    );
    if (link?.getAttribute("href")) {
      return { label: t("chat.messages.copyLink"), text: link.href };
    }
    const name = attachment.querySelector(
      ".chat-assistant-attachment-card__title, .chat-attachment-file__name",
    )?.textContent;
    if (name) {
      return { label: t("chat.messages.copyFileName"), text: name };
    }
  }
  return null;
}
