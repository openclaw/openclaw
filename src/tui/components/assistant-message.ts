import { Container, Markdown, Spacer } from "@mariozechner/pi-tui";
import { markdownTheme, theme } from "../theme/theme.js";

export class AssistantMessageComponent extends Container {
  private body: Markdown;

  constructor(text: string) {
    super();
    this.body = new Markdown(text, 1, 0, markdownTheme, {
      // Keep assistant body text in terminal default foreground so contrast
      // follows the user's terminal theme (dark or light).
      color: (line) => theme.assistantText(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(this.body);
  }

  setText(text: string) {
    this.body.setText(text);
  }
}
