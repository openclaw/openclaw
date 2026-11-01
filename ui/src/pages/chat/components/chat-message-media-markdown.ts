import type { Component } from "solid-js";
import type { ProjectedMessageContent } from "./chat-message-media.ts";

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
  return { markdown, media: { prefix, text, items, render } };
}
