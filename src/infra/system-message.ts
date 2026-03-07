export const SYSTEM_MARK = "⚙️";

function normalizeSystemText(value: string): string {
  return value.trim();
}

export function hasSystemMark(text: string): boolean {
  return normalizeSystemText(text).startsWith(SYSTEM_MARK);
}

export function prefixSystemMessage(text: string): string {
  const normalized = normalizeSystemText(text);
  if (!normalized) {
    return normalized;
  }
  if (hasSystemMark(normalized)) {
    return normalized;
  }
  return `${SYSTEM_MARK} ${normalized}`;
}
