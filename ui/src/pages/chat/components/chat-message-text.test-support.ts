import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import { solidContent } from "../../../lit/solid-content.tsx";
import type { MarkdownMedia } from "./chat-message-media-markdown.ts";
import type { DuplicateSuffix, MessageTextOptions } from "./chat-message-text-preparation.ts";
import { MessageMarkdown } from "./chat-message-text-view.tsx";

export function renderMessageMarkdown(
  markdown: string,
  messageKey: string,
  options: MessageTextOptions,
  markdownOptions: MarkdownRenderOptions,
  duplicateSuffix?: DuplicateSuffix,
  media?: MarkdownMedia,
) {
  return solidContent(MessageMarkdown, {
    markdown,
    messageKey,
    options,
    markdownOptions,
    duplicateSuffix,
    media,
  });
}
