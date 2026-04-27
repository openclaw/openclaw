import { Container, Spacer } from "@mariozechner/pi-tui";
import { markdownTheme } from "../theme/theme.js";
import { HyperlinkMarkdown } from "./hyperlink-markdown.js";
export class MarkdownMessageComponent extends Container {
    body;
    constructor(text, y, options) {
        super();
        this.body = new HyperlinkMarkdown(text, 0, y, markdownTheme, options);
        this.addChild(new Spacer(1));
        this.addChild(this.body);
    }
    setText(text) {
        this.body.setText(text);
    }
}
