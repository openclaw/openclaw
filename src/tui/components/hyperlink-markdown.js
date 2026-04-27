import { Markdown } from "@mariozechner/pi-tui";
import { addOsc8Hyperlinks, extractUrls } from "../osc8-hyperlinks.js";
/**
 * Wrapper around pi-tui's Markdown component that adds OSC 8 terminal
 * hyperlinks to rendered output, making URLs clickable even when broken
 * across multiple lines by word wrapping.
 */
export class HyperlinkMarkdown {
    inner;
    urls;
    constructor(text, paddingX, paddingY, theme, options) {
        this.inner = new Markdown(text, paddingX, paddingY, theme, options);
        this.urls = extractUrls(text);
    }
    render(width) {
        return addOsc8Hyperlinks(this.inner.render(width), this.urls);
    }
    setText(text) {
        this.inner.setText(text);
        this.urls = extractUrls(text);
    }
    invalidate() {
        this.inner.invalidate();
    }
}
