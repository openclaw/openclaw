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
    const value = opts?.sanitizeText ? opts.sanitizeText(content) : content;
    const normalized = normalize(value);
    return normalized ? normalized : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const chunks: string[] = [];
  const thinkingChunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const blockType = (block as { type?: unknown }).type;
    if (blockType === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text !== "string") {
        continue;
      }
      const value = opts?.sanitizeText ? opts.sanitizeText(text) : text;
      if (value.trim()) {
        chunks.push(value);
      }
    } else if (blockType === "thinking") {
      const thinking = (block as { thinking?: unknown }).thinking;
      if (typeof thinking === "string" && thinking.trim()) {
        thinkingChunks.push(thinking);
      }
    }
  }

  // Prefer text blocks; fall back to thinking blocks when text is empty
  // to avoid silently dropping content from models that place their
  // response in thinking blocks (e.g. extended-thinking / high-thinking modes).
  const source = chunks.length > 0 ? chunks : thinkingChunks;
  const joined = normalize(source.join(joinWith));
  return joined ? joined : null;
}
