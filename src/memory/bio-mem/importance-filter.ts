const FILLER_PATTERNS = [
  /^嗯+[。.!！]*$/u,
  /^好的?[。.!！]*$/u,
  /^了解[。.!！]*$/u,
  /^明白[。.!！]*$/u,
  /^好[。.!！]*$/u,
  /^ok[.!]*$/i,
  /^okay[.!]*$/i,
  /^sure[.!]*$/i,
  /^yep[.!]*$/i,
  /^yes[.!]*$/i,
  /^got it[.!]*$/i,
  /^thanks?[.!]*$/i,
  /^thank you[.!]*$/i,
  /^謝謝[。!！]*$/u,
  /^不客氣[。.!！]*$/u,
  /^沒關係[。.!！]*$/u,
];

const MIN_CONTENT_LENGTH = 10;

function isFiller(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < MIN_CONTENT_LENGTH) {
    return true;
  }
  return FILLER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export type FilterableMessage = {
  role: string;
  content: string;
};

export function filterImportantMessages(
  messages: FilterableMessage[],
  options?: { maxSize?: number },
): FilterableMessage[] {
  const maxSize = options?.maxSize ?? 20;
  const filtered = messages.filter((msg) => !isFiller(msg.content));
  if (filtered.length <= maxSize) {
    return filtered;
  }
  return filtered.slice(filtered.length - maxSize);
}
