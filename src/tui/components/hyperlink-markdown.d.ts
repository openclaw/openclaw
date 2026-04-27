import type { Component, DefaultTextStyle, MarkdownTheme } from "@mariozechner/pi-tui";
/**
 * Wrapper around pi-tui's Markdown component that adds OSC 8 terminal
 * hyperlinks to rendered output, making URLs clickable even when broken
 * across multiple lines by word wrapping.
 */
export declare class HyperlinkMarkdown implements Component {
    private inner;
    private urls;
    constructor(text: string, paddingX: number, paddingY: number, theme: MarkdownTheme, options?: DefaultTextStyle);
    render(width: number): string[];
    setText(text: string): void;
    invalidate(): void;
}
