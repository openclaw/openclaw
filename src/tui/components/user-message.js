import { theme } from "../theme/theme.js";
import { MarkdownMessageComponent } from "./markdown-message.js";
export class UserMessageComponent extends MarkdownMessageComponent {
    constructor(text) {
        super(text, 1, {
            bgColor: (line) => theme.userBg(line),
            color: (line) => theme.userText(line),
        });
    }
}
