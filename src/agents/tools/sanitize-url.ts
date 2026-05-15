export function sanitizeUrlInput(raw: string): string {
  if (typeof raw !== "string") {
    return raw;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  const httpsIdx = lower.indexOf("https://");
  const httpIdx = lower.indexOf("http://");
  const candidates = [httpsIdx, httpIdx].filter((i) => i >= 0);
  if (candidates.length === 0) {
    return trimmed;
  }
  const start = Math.min(...candidates);
  return start === 0 ? trimmed : trimmed.slice(start);
}
