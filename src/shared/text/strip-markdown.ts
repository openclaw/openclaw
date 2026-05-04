/**
 * Strip lightweight markdown formatting from text while preserving readable
 * plain-text structure for TTS and channel fallbacks.
 */
export function stripMarkdown(text: string): string {
  let result = text;

  // Remove fenced code blocks: ```lang\ncode\n``` — must run before inline-code
  // stripping so triple-backtick fences don't get partially consumed.
  // The trailing \n? before the closing fence prevents capturing the final newline
  // so fences embedded in surrounding text don't insert an extra blank line.
  result = result.replace(/```(?:[^\n]*)\n?([\s\S]*?)\n?```/g, "$1");

  result = result.replace(/\*\*(.+?)\*\*/g, "$1");
  result = result.replace(/__(.+?)__/g, "$1");

  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1");
  result = result.replace(/(?<![\p{L}\p{N}])_(?!_)(.+?)(?<!_)_(?![\p{L}\p{N}])/gu, "$1");

  result = result.replace(/~~(.+?)~~/g, "$1");
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "$1");
  result = result.replace(/^>\s?(.*)$/gm, "$1");
  result = result.replace(/^[-*_]{3,}$/gm, "");
  result = result.replace(/`([^`]+)`/g, "$1");
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}
