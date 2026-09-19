import { html } from "lit";
import { Directive, directive } from "lit/directive.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { ProjectedMessageContent } from "./chat-message-media.ts";

type PositionedMedia = Exclude<ProjectedMessageContent, { type: "text" }>;
export type MarkdownMedia = {
  prefix: string;
  text: string;
  items: PositionedMedia[];
  render: (item: PositionedMedia, index: number) => unknown;
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

function hasParagraphContent(node: Node): boolean {
  return Array.from(node.childNodes).some((child) =>
    child.nodeType === Node.TEXT_NODE ? child.textContent?.trim() : child.nodeName !== "BR",
  );
}

class MarkdownMediaDirective extends Directive {
  private source = "";
  private prefix = "";
  private strings: TemplateStringsArray | undefined;
  private indexes: number[] = [];

  render(sanitizedHtml: string, media?: MarkdownMedia) {
    if (!media) {
      return unsafeHTML(sanitizedHtml);
    }
    if (this.source !== sanitizedHtml || this.prefix !== media.prefix || !this.strings) {
      this.source = sanitizedHtml;
      this.prefix = media.prefix;
      const template = document.createElement("template");
      template.innerHTML = sanitizedHtml;
      const marker = new RegExp(`${media.prefix}(\\d+)END`, "g");
      const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      const slots: Comment[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node instanceof Text && node.data.includes(media.prefix)) {
          nodes.push(node);
        }
      }
      // Only our collision-free text markers become bindings. Never interpolate
      // attribute values or unsanitized model HTML into a Lit template.
      for (const node of nodes) {
        const fragment = document.createDocumentFragment();
        let offset = 0;
        for (const match of node.data.matchAll(marker)) {
          fragment.append(node.data.slice(offset, match.index));
          const slot = document.createComment(match[0]);
          slots.push(slot);
          fragment.append(slot);
          offset = match.index + match[0].length;
        }
        fragment.append(node.data.slice(offset));
        node.replaceWith(fragment);
      }
      // Media cards are blocks. Split their containing paragraph while retaining
      // list items, quotes, and other surrounding Markdown structure.
      for (const slot of slots) {
        const paragraph = slot.parentElement?.closest("p");
        if (!paragraph) {
          continue;
        }
        const before = paragraph.cloneNode(false);
        const range = document.createRange();
        range.setStart(paragraph, 0);
        range.setEndBefore(slot);
        before.appendChild(range.extractContents());
        if (hasParagraphContent(before)) {
          paragraph.before(before);
        }
        paragraph.before(slot);
        if (!hasParagraphContent(paragraph)) {
          paragraph.remove();
        }
      }
      const parts = template.innerHTML.split(new RegExp(`<!--${media.prefix}(\\d+)END-->`, "g"));
      const strings = parts.filter((_, index) => index % 2 === 0);
      this.strings = Object.assign(strings, { raw: strings });
      this.indexes = parts.filter((_, index) => index % 2 === 1).map(Number);
    }
    return html(
      this.strings,
      ...this.indexes.map((index) => {
        const item = media.items[index];
        return item ? media.render(item, index) : undefined;
      }),
    );
  }
}

export const renderMarkdownMedia = directive(MarkdownMediaDirective);
