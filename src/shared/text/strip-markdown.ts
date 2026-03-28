/**
 * Strip lightweight markdown formatting from text while preserving readable
 * plain-text structure for TTS and channel fallbacks.
 */
export function stripMarkdown(text: string): string {
  let result = text;

  // Fenced code blocks: ```lang\ncode\n``` → code
  result = result.replace(/```[a-z]*\n?([\s\S]*?)```/g, "$1");

  // Bold: **text** and __text__
  result = result.replace(/\*\*(.+?)\*\*/g, "$1");
  result = result.replace(/__(.+?)__/g, "$1");

  // Italic: *text* and _text_ (negative lookahead/behind to avoid ** and __)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1");
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "$1");

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, "$1");

  // Headings: # text (start of line only)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "$1");

  // Blockquotes: > text
  result = result.replace(/^>\s?(.*)$/gm, "$1");

  // Horizontal rules: ---, ***, ___
  result = result.replace(/^[-*_]{3,}$/gm, "");

  // Inline code: `text`
  result = result.replace(/`([^`]+)`/g, "$1");

  // Bullet points: - item or * item (start of line)
  result = result.replace(/^[-*]\s+/gm, "");

  // Numbered lists: 1. item (start of line)
  result = result.replace(/^\d+\.\s+/gm, "");

  // Links: [text](url) → text
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Collapse 3+ consecutive newlines into 2
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}
