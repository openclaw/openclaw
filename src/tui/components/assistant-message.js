import { Container, Spacer } from "@mariozechner/pi-tui";
import { markdownTheme, theme } from "../theme/theme.js";
import { HyperlinkMarkdown } from "./hyperlink-markdown.js";
export class AssistantMessageComponent extends Container {
    body;
    constructor(text) {
        super();
        this.body = new HyperlinkMarkdown(text, 0, 0, markdownTheme, {
            // Keep assistant body text in terminal default foreground so contrast
            // follows the user's terminal theme (dark or light).
            color: (line) => theme.assistantText(line),
        });
        this.addChild(new Spacer(1));
        this.addChild(this.body);
    }
    setText(text) {
        this.body.setText(text);
    }
}
