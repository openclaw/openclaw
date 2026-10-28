import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { markdownTheme, tuiTheme as theme } from "../theme/theme.js";
import { sanitizeTerminalControlsAndBinary } from "../tui-formatters.js";
import type { TuiImageSource } from "../tui-images.js";
import { HyperlinkMarkdown } from "./hyperlink-markdown.js";
import { MessageImages, type TuiImageRenderer } from "./message-images.js";

const PLAIN_LABELS = { user: "You:", assistant: "Assistant:" } as const;

/**
 * Screen reader rendering: unstyled labeled text. While streaming, only completed rows show: the
 * last wrapped row is held back, so an announced row never changes. finish() reveals it.
 */
export type PlainMessageOptions = { streaming: boolean };

class StreamingText extends Text {
  hold = false;

  override render(width: number): string[] {
    const rows = super.render(width);
    return this.hold ? rows.slice(0, -1) : rows;
  }
}

export class MarkdownMessageComponent extends Container {
  private body: HyperlinkMarkdown | StreamingText;
  private images: MessageImages;
  private raw = "";
  private streaming = false;

  constructor(
    readonly role: "user" | "assistant",
    text: string,
    imageRenderer?: TuiImageRenderer,
    private readonly plain?: PlainMessageOptions,
  ) {
    super();
    if (plain) {
      this.streaming = plain.streaming;
      this.body = new StreamingText("", 0, 0);
      this.addChild(this.body);
      this.images = new MessageImages(imageRenderer);
      this.addChild(this.images);
      this.setText(text);
      return;
    }
    const user = role === "user";
    this.body = new HyperlinkMarkdown(
      text,
      0,
      user ? 1 : 0,
      markdownTheme,
      user
        ? { bgColor: (line) => theme.userBg(line), color: (line) => theme.userText(line) }
        : { color: (line) => theme.assistantText(line) },
      user ? { preserveOrderedListMarkers: true, preserveBackslashEscapes: true } : undefined,
    );
    this.addChild(new Spacer(1));
    this.addChild(this.body);
    this.images = new MessageImages(imageRenderer);
    this.addChild(this.images);
  }

  setText(text: string) {
    if (!this.plain) {
      this.body.setText(text);
      return;
    }
    this.raw = sanitizeTerminalControlsAndBinary(text);
    this.renderPlain();
  }

  finish() {
    if (!this.plain) {
      return;
    }
    this.streaming = false;
    this.renderPlain();
  }

  private renderPlain() {
    // The text itself is never rewritten: code and quoted strings must read as sent.
    const body = this.body;
    if (!(body instanceof StreamingText)) {
      return;
    }
    body.hold = this.streaming;
    const text = this.streaming ? this.raw.trimStart() : this.raw.trim();
    body.setText(text.trim() ? `${PLAIN_LABELS[this.role]} ${text}` : "");
  }

  setImages(images: readonly TuiImageSource[]) {
    this.images.setImages(images);
  }

  dispose() {
    this.images.dispose();
  }
}
