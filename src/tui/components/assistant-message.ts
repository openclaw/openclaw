import { Container, Markdown, Spacer } from "@mariozechner/pi-tui";
import { markdownTheme, theme } from "../theme/theme.js";

// URL regex that matches http/https URLs in various contexts
const URL_REGEX = /https?:\/\/[^\s\)<>\[\]"']+/g;

/**
 * Preprocesses text to prevent URLs from being broken during line wrapping.
 * The issue occurs when the markdown renderer wraps long lines and inserts spaces
 * within URLs, making them unclickable. We prevent this by replacing all internal
 * breakable characters in URLs with non-breaking equivalents.
 */
function preprocessUrlsForWrapping(text: string): string {
  return text.replace(URL_REGEX, (url) => {
    // Convert URL to use non-breaking characters to prevent line wrapping
    // within the URL while maintaining visual appearance and functionality
    return url
      // Replace regular spaces with non-breaking spaces
      .replace(/ /g, '\u00A0')
      // Add zero-width non-joiner after common break points to discourage breaking
      .replace(/\//g, '/\u200C')   // After slashes
      .replace(/-/g, '-\u200C')    // After hyphens  
      .replace(/\./g, '.\u200C')   // After dots
      .replace(/=/g, '=\u200C')    // After equals (query params)
      .replace(/&/g, '&\u200C')    // After ampersands (query params)
      .replace(/_/g, '_\u200C');   // After underscores
  });
}

export class AssistantMessageComponent extends Container {
  private body: Markdown;

  constructor(text: string) {
    super();
    const processedText = preprocessUrlsForWrapping(text);
    this.body = new Markdown(processedText, 1, 0, markdownTheme, {
      // Keep assistant body text in terminal default foreground so contrast
      // follows the user's terminal theme (dark or light).
      color: (line) => theme.assistantText(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(this.body);
  }

  setText(text: string) {
    const processedText = preprocessUrlsForWrapping(text);
    this.body.setText(processedText);
  }
}
