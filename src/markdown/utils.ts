/**
 * Strip markdown formatting from text for TTS processing.
 * This is a lightweight implementation that handles common markdown patterns.
 */
export function stripMarkdown(text: string): string {
  let result = text;

  // Remove code blocks
  result = result.replace(/```[\s\S]*?```/g, "");
  result = result.replace(/`([^`]+)`/g, "$1");

  // Remove headers
  result = result.replace(/^#{1,6}\s+/gm, "");

  // Remove bold/italic
  result = result.replace(/\*\*([^*]+)\*\*/g, "$1");
  result = result.replace(/\*([^*]+)\*/g, "$1");
  result = result.replace(/__([^_]+)__/g, "$1");
  result = result.replace(/_([^_]+)_/g, "$1");

  // Remove links but keep text
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Remove images
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");

  // Remove blockquotes
  result = result.replace(/^>\s+/gm, "");

  // Remove horizontal rules
  result = result.replace(/^[-*_]{3,}$/gm, "");

  // Remove list markers
  result = result.replace(/^[\s]*[-*+]\s+/gm, "");
  result = result.replace(/^[\s]*\d+\.\s+/gm, "");

  return result;
}
