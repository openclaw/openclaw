// Basic input sanitization utilities for session/tool outputs

export function sanitizeUserInput(input: string, maxLen = 10000): string {
  if (typeof input !== "string") return input as unknown as string;
  // Remove suspicious control characters
  let s = input.replace(/[\x00-\x1F\x7F]+/g, " ");
  // Remove common LLM prompt injection markers and code fences
  s = s.replace(/```[\s\S]*?```/g, " [REDACTED CODE] ");
  s = s.replace(/<final>|<\/final>/gi, "");
  // Collapse whitespace and trim
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen) + "...";
  return s;
}
