export function extractTextFromChatContent(
  content: unknown,
  opts?: { sanitizeText?: (text: string) => string },
): string | null {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

  if (typeof content === "string") {
    const value = opts?.sanitizeText ? opts.sanitizeText(content) : content;
    const normalized = normalize(value);
    return normalized ? normalized : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const chunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if ((block as { type?: unknown }).type !== "text") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string") {
      continue;
    }
    const value = opts?.sanitizeText ? opts.sanitizeText(text) : text;
    if (value.trim()) {
      chunks.push(value);
    }
  }

  const joined = normalize(chunks.join(" "));
  return joined ? joined : null;
}
