import { Container, Spacer } from "@earendil-works/pi-tui";
import { markdownTheme, tuiTheme as theme } from "../theme/theme.js";
import type { TuiImageSource } from "../tui-images.js";
import { HyperlinkMarkdown } from "./hyperlink-markdown.js";
import { MessageImages, type TuiImageRenderer } from "./message-images.js";

export class MarkdownMessageComponent extends Container {
  private body: HyperlinkMarkdown;
  private images: MessageImages;

  constructor(
    readonly role: "user" | "assistant",
    text: string,
    imageRenderer?: TuiImageRenderer,
  ) {
    super();
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
    this.body.setText(text);
  }

  setImages(images: readonly TuiImageSource[]) {
    this.images.setImages(images);
  }

  dispose() {
    this.images.dispose();
  }
}
