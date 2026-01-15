const DEFAULT_KEY_PREVIEW = { head: 4, tail: 4 };

export function normalizeApiKeyInput(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";

  // Handle shell-style assignments: export KEY="value" or KEY=value
  const assignmentMatch = trimmed.match(/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/);
  const valuePart = assignmentMatch ? assignmentMatch[1].trim() : trimmed;

  const unquoted =
    valuePart.length >= 2 &&
    ((valuePart.startsWith('"') && valuePart.endsWith('"')) ||
      (valuePart.startsWith("'") && valuePart.endsWith("'")) ||
      (valuePart.startsWith("`") && valuePart.endsWith("`")))
      ? valuePart.slice(1, -1)
      : valuePart;

  const withoutSemicolon = unquoted.endsWith(";") ? unquoted.slice(0, -1) : unquoted;

  return withoutSemicolon.trim();
}

export const validateApiKeyInput = (value: string) =>
  normalizeApiKeyInput(value).length > 0 ? undefined : "Required";

export function validateGroqApiKey(value: string): string | undefined {
  const normalized = normalizeApiKeyInput(value);
  if (!normalized) return "API key is required";
  if (normalized.length < 20) return "API key appears too short";
  if (!normalized.startsWith("gsk_")) {
    return "Groq API keys start with gsk_";
  }
  return undefined;
}

export function validateGeminiApiKey(value: string): string | undefined {
  const normalized = normalizeApiKeyInput(value);
  if (!normalized) return "API key is required";
  if (normalized.length < 30) return "API key appears too short";
  // Gemini keys typically start with "AIza" but format varies
  return undefined;
}

export function formatApiKeyPreview(
  raw: string,
  opts: { head?: number; tail?: number } = {},
): string {
  const trimmed = raw.trim();
  if (!trimmed) return "…";
  const head = opts.head ?? DEFAULT_KEY_PREVIEW.head;
  const tail = opts.tail ?? DEFAULT_KEY_PREVIEW.tail;
  if (trimmed.length <= head + tail) {
    const shortHead = Math.min(2, trimmed.length);
    const shortTail = Math.min(2, trimmed.length - shortHead);
    if (shortTail <= 0) {
      return `${trimmed.slice(0, shortHead)}…`;
    }
    return `${trimmed.slice(0, shortHead)}…${trimmed.slice(-shortTail)}`;
  }
  return `${trimmed.slice(0, head)}…${trimmed.slice(-tail)}`;
}
