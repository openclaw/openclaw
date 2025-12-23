export function extractModelDirective(body?: string): {
  cleaned: string;
  rawModel?: string;
  hasDirective: boolean;
} {
  if (!body) return { cleaned: "", hasDirective: false };
  const match = body.match(
    /(?:^|\s)\/model(?=$|\s|:)\s*:?\s*([A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+)?)?/i,
  );
  const rawModel = match?.[1]?.trim();
  const cleaned = match
    ? body.replace(match[0], "").replace(/\s+/g, " ").trim()
    : body.trim();
  return {
    cleaned,
    rawModel,
    hasDirective: !!match,
  };
}
