import type { DefaultTextStyle, MarkdownOptions, MarkdownTheme } from "@earendil-works/pi-tui";
import { Markdown } from "@earendil-works/pi-tui";
import { addOsc8Hyperlinks, extractUrls } from "../osc8-hyperlinks.js";
import { isolateRtlRenderedLine, sanitizeTerminalControlsAndBinary } from "../tui-formatters.js";

function sanitizeMarkdownDisplayText(text: string): string {
  if (!text) {
    return text;
  }
  return sanitizeTerminalControlsAndBinary(text) || "(no output)";
}

/**
 * Wrapper around pi-tui's Markdown component that adds OSC 8 terminal
 * hyperlinks to rendered output, making URLs clickable even when broken
 * across multiple lines by word wrapping.
 */
export class HyperlinkMarkdown extends Markdown {
  private urls: ReadonlySet<string>;
  private cachedRender?: { width: number; lines: string[] };

  constructor(
    text: string,
    paddingX: number,
    paddingY: number,
    theme: MarkdownTheme,
    defaultTextStyle?: DefaultTextStyle,
    options?: MarkdownOptions,
  ) {
    const displayText = sanitizeMarkdownDisplayText(text);
    super(displayText, paddingX, paddingY, theme, defaultTextStyle, options);
    this.urls = extractUrls(displayText);
  }

  override render(width: number): string[] {
    if (this.cachedRender?.width === width) {
      return this.cachedRender.lines;
    }
    const lines = addOsc8Hyperlinks(super.render(width), this.urls).map(isolateRtlRenderedLine);
    this.cachedRender = { width, lines };
    return lines;
  }

  override setText(text: string): void {
    const displayText = sanitizeMarkdownDisplayText(text);
    super.setText(displayText);
    this.urls = extractUrls(displayText);
  }

  override invalidate(): void {
    super.invalidate();
    this.cachedRender = undefined;
  }
}
