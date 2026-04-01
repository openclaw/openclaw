export function extractTextFromChatContent(
  content: unknown,
  opts?: {
    sanitizeText?: (text: string) => string;
    joinWith?: string;
    normalizeText?: (text: string) => string;
  },
): string | null {
  const normalizeText = opts?.normalizeText ?? ((text: string) => text.replace(/\s+/g, " ").trim());
  const joinWith = opts?.joinWith ?? " ";
  const coerceText = (value: unknown): string =>
    typeof value === "string" ? value : value == null ? "" : String(value);
  const sanitize = (text: unknown): string => {
    const raw = coerceText(text);
    const sanitized = opts?.sanitizeText ? opts.sanitizeText(raw) : raw;
    return coerceText(sanitized);
  };
  const normalize = (text: unknown): string => coerceText(normalizeText(coerceText(text)));

  if (typeof content === "string") {
    const value = sanitize(content);
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
    const value = sanitize(text);
    if (value.trim()) {
      chunks.push(value);
    }
  }

  const joined = normalize(chunks.join(joinWith));
  return joined ? joined : null;
}
