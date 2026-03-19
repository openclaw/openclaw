import { theme } from "../theme/theme.js";
import { MarkdownMessageComponent } from "./markdown-message.js";

export class UserMessageComponent extends MarkdownMessageComponent {
  constructor(text: string, promptId?: string) {
    const body = promptId ? `${theme.dim(`id ${promptId}`)}\n${text}` : text;
    super(body, 1, {
      bgColor: (line) => theme.userBg(line),
      color: (line) => theme.userText(line),
    });
  }
}
