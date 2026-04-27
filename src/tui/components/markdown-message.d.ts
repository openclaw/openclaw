import { Container } from "@mariozechner/pi-tui";
import { HyperlinkMarkdown } from "./hyperlink-markdown.js";
type MarkdownOptions = ConstructorParameters<typeof HyperlinkMarkdown>[4];
export declare class MarkdownMessageComponent extends Container {
    private body;
    constructor(text: string, y: number, options?: MarkdownOptions);
    setText(text: string): void;
}
export {};
