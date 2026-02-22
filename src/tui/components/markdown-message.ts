import { Container, Markdown, Spacer } from "@mariozechner/pi-tui";
import { markdownTheme } from "../theme/theme.js";

type MarkdownOptions = ConstructorParameters<typeof Markdown>[4];

export class MarkdownMessageComponent extends Container {
  private body: Markdown;

  constructor(text: string, y: number, options?: MarkdownOptions) {
    super();
    this.body = new Markdown(text, 1, y, markdownTheme, options);
    this.addChild(new Spacer(1));
    this.addChild(this.body);
  }

  setText(text: string) {
    this.body.setText(text);
  }
}
