import { noChange, nothing, render } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import {
  MarkdownDomReconciler,
  type MarkdownDomMedia,
} from "../../../lib/markdown-dom-reconciler.ts";
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

/** Translate the retained media lifecycle without exposing the renderer to the DOM owner. */
export function markdownMediaRenderer(media?: MarkdownMedia): MarkdownDomMedia | undefined {
  if (!media) {
    return undefined;
  }
  return {
    prefix: media.prefix,
    render(index, container) {
      const item = media.items[index];
      if (!item) {
        return undefined;
      }
      const part = render(media.render(item, index), container);
      return {
        setConnected: (connected) => part.setConnected(connected),
        dispose: () => {
          render(nothing, container);
        },
      };
    },
  };
}

class MarkdownMediaDirective extends AsyncDirective {
  private readonly container = document.createDocumentFragment();
  private readonly owner = new MarkdownDomReconciler(this.container);
  private rendered = false;

  render(sanitizedHtml: string, media?: MarkdownMedia, incremental = false) {
    this.owner.setConnected(this.isConnected);
    this.owner.updateHtml(sanitizedHtml, markdownMediaRenderer(media), incremental);
    if (this.rendered) {
      return noChange;
    }
    this.rendered = true;
    return this.container;
  }

  protected override disconnected() {
    this.owner.setConnected(false);
  }

  protected override reconnected() {
    this.owner.setConnected(true);
  }
}

export const renderMarkdownMedia = directive(MarkdownMediaDirective);
