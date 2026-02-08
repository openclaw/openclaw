const DEFAULT_KEY_PREVIEW = { head: 4, tail: 4 };

export function normalizeApiKeyInput(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return "";
  }

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

export const validateApiKeyInput = (value: string) => {
  const normalized = normalizeApiKeyInput(value);
  if (normalized.length === 0) {
    return "Required";
  }
  // Detect if user pasted a setup-token instead of an API key
  if (normalized.startsWith("sk-ant-oat01-")) {
    return "That looks like a setup-token. Select 'Anthropic token (paste setup-token)' instead of 'Anthropic API key'.";
  }
  return undefined;
};

export function formatApiKeyPreview(
  raw: string,
  opts: { head?: number; tail?: number } = {},
): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "…";
  }
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
