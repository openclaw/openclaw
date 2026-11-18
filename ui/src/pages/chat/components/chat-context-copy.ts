import { readMarkdownCodeBlockCopyText } from "../../../components/markdown-code-blocks.ts";
import { markdownTableCopyText } from "../../../components/markdown-tables.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { readAttachmentContextCopy } from "./chat-attachment-context-copy.ts";

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
    const copy = readAttachmentContextCopy(attachment);
    if (copy?.href) {
      return {
        label: t("chat.messages.copyLink"),
        text: URL.parse(copy.href, attachment.ownerDocument.baseURI)?.href ?? copy.href,
      };
    }
    if (copy?.name) {
      return { label: t("chat.messages.copyFileName"), text: copy.name };
    }
  }
  return null;
}
