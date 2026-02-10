import { Container, Markdown, Spacer } from "@mariozechner/pi-tui";
import { markdownTheme, theme } from "../theme/theme.js";

/**
 * Convert single newlines into CommonMark hard line-breaks (`  \n`) so that
 * the `marked` lexer (used by pi-tui's Markdown component) preserves them
 * instead of collapsing them into spaces (CommonMark "soft break" behaviour).
 *
 * Double-newlines (`\n\n`) are left untouched as they already denote paragraph
 * breaks. Lines that already end with two trailing spaces are also left alone.
 * CRLF (`\r\n`) is normalized to `\n` before conversion.
 */
export function preserveNewlines(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  return normalized.replace(/([^\n])(?<! {2})\n(?!\n)/g, "$1  \n");
}

export class AssistantMessageComponent extends Container {
  private body: Markdown;

  constructor(text: string) {
    super();
    this.body = new Markdown(preserveNewlines(text), 1, 0, markdownTheme, {
      // Keep assistant body text in terminal default foreground so contrast
      // follows the user's terminal theme (dark or light).
      color: (line) => theme.assistantText(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(this.body);
  }

  setText(text: string) {
    this.body.setText(preserveNewlines(text));
  }
}
