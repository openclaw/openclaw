import { Container, Spacer } from "@earendil-works/pi-tui";
import { markdownTheme } from "../theme/theme.js";
import type { TuiImageSource } from "../tui-images.js";
import { HyperlinkMarkdown } from "./hyperlink-markdown.js";
import { MessageImages, type TuiImageRenderer } from "./message-images.js";

type DefaultTextStyle = ConstructorParameters<typeof HyperlinkMarkdown>[4];
type MarkdownOptions = ConstructorParameters<typeof HyperlinkMarkdown>[5];

/** Container-backed markdown message that can update text in place. */
export class MarkdownMessageComponent extends Container {
  private body: HyperlinkMarkdown;
  private images: MessageImages;

  constructor(
    text: string,
    y: number,
    defaultTextStyle?: DefaultTextStyle,
    options?: MarkdownOptions,
    imageRenderer?: TuiImageRenderer,
  ) {
    super();
    this.body = new HyperlinkMarkdown(text, 0, y, markdownTheme, defaultTextStyle, options);
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
