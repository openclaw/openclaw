import { noChange, nothing, render as renderLit } from "lit";
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
function markdownMediaRenderer(media?: MarkdownMedia): MarkdownDomMedia | undefined {
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
      const part = renderLit(media.render(item, index), container);
      return {
        setConnected: (connected) => part.setConnected(connected),
        dispose: () => {
          renderLit(nothing, container);
        },
      };
    },
  };
}

type MarkdownContent =
  | string
  | {
      messageKey: string;
      source: string;
      parts: readonly [string, string];
    };

class MarkdownMediaDirective extends AsyncDirective {
  private readonly container = document.createDocumentFragment();
  private readonly owner = new MarkdownDomReconciler(this.container);
  private rendered = false;

  render(content: MarkdownContent, media?: MarkdownMedia, incremental = false) {
    this.owner.setConnected(this.isConnected);
    const renderer = markdownMediaRenderer(media);
    if (typeof content === "string") {
      this.owner.updateHtml(content, renderer, incremental);
    } else {
      this.owner.update(content.messageKey, content.source, content.parts, renderer);
    }
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
