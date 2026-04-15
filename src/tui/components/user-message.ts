import { theme } from "../theme/theme.js";
import { MarkdownMessageComponent } from "./markdown-message.js";
import { prefixTimestamp } from "./timestamp.js";

export class UserMessageComponent extends MarkdownMessageComponent {
  constructor(text: string) {
    super(prefixTimestamp(text), 1, {
      bgColor: (line) => theme.userBg(line),
      color: (line) => theme.userText(line),
    });
  }
}
