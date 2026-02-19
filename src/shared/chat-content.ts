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
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as {
      type?: unknown;
      text?: unknown;
      refusal?: unknown;
      content?: unknown;
    };
    const blockType = typeof record.type === "string" ? record.type : "";
    const isTextLikeBlock =
      blockType === "text" || blockType === "output_text" || blockType === "refusal";
    if (!isTextLikeBlock) {
      continue;
    }
    const textValue =
      typeof record.text === "string"
        ? record.text
        : typeof record.refusal === "string"
          ? record.refusal
          : typeof record.content === "string"
            ? record.content
            : undefined;
    if (typeof textValue !== "string") {
      continue;
    }
    const value = opts?.sanitizeText ? opts.sanitizeText(textValue) : textValue;
    if (value.trim()) {
      chunks.push(value);
    }
  }

  const joined = normalize(chunks.join(joinWith));
  return joined ? joined : null;
}
