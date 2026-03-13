export function extractTextFromChatContent(
  content: unknown,
  opts?: {
    sanitizeText?: (text: string) => string;
    joinWith?: string;
    normalizeText?: (text: string) => string;
  },
): string | null {
  const normalize = opts?.normalizeText ?? ((text: string) => text.replace(/\s+/g, " ").trim());
  const joinWith = opts?.joinWith ?? " ";

  if (typeof content === "string") {
    // Detect JSON-stringified arrays of content blocks (e.g. from vLLM openai-completions).
    // Without this guard the string would be returned as-is and later double-serialized.
    if (content.startsWith("[") && content.endsWith("]")) {
      try {
        const parsed: unknown = JSON.parse(content);
        if (
          Array.isArray(parsed) &&
          parsed.length > 0 &&
          parsed.every(
            (item) => item && typeof item === "object" && "type" in item && "text" in item,
          )
        ) {
          return extractTextFromChatContent(parsed, opts);
        }
      } catch {
        // Not valid JSON – fall through and treat as plain text.
      }
    }

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

  const joined = normalize(chunks.join(joinWith));
  return joined ? joined : null;
}
