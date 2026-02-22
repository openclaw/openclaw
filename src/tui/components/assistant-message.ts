import { theme } from "../theme/theme.js";
import { MarkdownMessageComponent } from "./markdown-message.js";

export class AssistantMessageComponent extends MarkdownMessageComponent {
  constructor(text: string) {
    super(text, 0, {
      // Keep assistant body text in terminal default foreground so contrast
      // follows the user's terminal theme (dark or light).
      color: (line) => theme.assistantText(line),
    });
  }
}
