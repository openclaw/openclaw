import type { Component } from "solid-js";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { isInlineChatImage } from "./chat-image-lightbox.ts";
import type { ImageBlock, ProjectedMessageContent } from "./chat-message-media.ts";

export type PositionedMedia = Exclude<ProjectedMessageContent, { type: "text" }>;
export type MarkdownMedia = {
  prefix: string;
  text: string;
  items: PositionedMedia[];
  render: Component<{ item: PositionedMedia; index: number }>;
};

export function prepareMarkdownMedia(
  content: readonly ProjectedMessageContent[],
  render: MarkdownMedia["render"],
): { markdown: string; media: MarkdownMedia } {
  const { markdown, ...media } = prepareMarkdownMediaSource(content);
  return { markdown, media: { ...media, render } };
}

/** Slot preparation is pure; offscreen warming must not mount media resources. */
export function prepareMarkdownMediaSource(content: readonly ProjectedMessageContent[]) {
  const text = content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
  let prefix = "OPENCLAWMEDIASLOT";
  while (text.includes(prefix)) {
    prefix += "X";
  }
  const items: PositionedMedia[] = [];
  const markdown = content
    .map((item) => {
      if (item.type === "text") {
        return item.text;
      }
      items.push(item);
      return `${prefix}${items.length - 1}END`;
    })
    .join("\n");
  return { markdown, prefix, text, items };
}

export function readMarkdownImageSlots(
  markdown: string,
  options: MarkdownRenderOptions,
  media?: ReturnType<typeof prepareMarkdownMediaSource>,
) {
  const template = document.createElement("template");
  template.innerHTML = toSanitizedMarkdownHtml(markdown, options);
  const walker = document.createTreeWalker(
    template.content,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  );
  const images: ImageBlock[] = [];
  const inlineImages: ImageBlock[] = [];
  const marker = media ? new RegExp(media.prefix + "(\\d+)END", "g") : undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (isInlineChatImage(node)) {
      const image: ImageBlock = { url: node.src, alt: node.alt };
      images.push(image);
      inlineImages.push(image);
    } else if (node instanceof Text && marker && media) {
      for (const match of node.data.matchAll(marker)) {
        const item = media.items[Number(match[1])];
        if (item?.type === "image") {
          images.push(item.image);
        }
      }
    }
  }
  return { images, inlineImages };
}
