import type { Component, DefaultTextStyle, MarkdownTheme } from "@mariozechner/pi-tui";
import { Markdown } from "@mariozechner/pi-tui";
import {
  type LinkTextMapping,
  addOsc8Hyperlinks,
  extractLinkTextMappings,
  extractUrls,
} from "../osc8-hyperlinks.js";

/**
 * Wrapper around pi-tui's Markdown component that adds OSC 8 terminal
 * hyperlinks to rendered output, making URLs clickable even when broken
 * across multiple lines by word wrapping.
 */
export class HyperlinkMarkdown implements Component {
  private inner: Markdown;
  private urls: string[];
  private linkTexts: LinkTextMapping[];

  constructor(
    text: string,
    paddingX: number,
    paddingY: number,
    theme: MarkdownTheme,
    options?: DefaultTextStyle,
  ) {
    this.inner = new Markdown(text, paddingX, paddingY, theme, options);
    this.urls = extractUrls(text);
    this.linkTexts = extractLinkTextMappings(text);
  }

  render(width: number): string[] {
    return addOsc8Hyperlinks(this.inner.render(width), this.urls, this.linkTexts);
  }

  setText(text: string): void {
    this.inner.setText(text);
    this.urls = extractUrls(text);
    this.linkTexts = extractLinkTextMappings(text);
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}
