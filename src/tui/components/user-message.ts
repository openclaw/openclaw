import { Container, Markdown, Spacer } from "@mariozechner/pi-tui";
import { markdownTheme, theme } from "../theme/theme.js";
import { clampLinesToWidth } from "./safe-render.js";

export class UserMessageComponent extends Container {
  private body: Markdown;

  constructor(text: string) {
    super();
    this.body = new Markdown(text, 1, 1, markdownTheme, {
      bgColor: (line) => theme.userBg(line),
      color: (line) => theme.userText(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(this.body);
  }

  setText(text: string) {
    this.body.setText(text);
  }

  override render(width: number): string[] {
    return clampLinesToWidth(super.render(width), width);
  }
}
