import type { TextSearchMatch } from "./types.js";

export function searchText(
  content: string,
  query: string,
  options?: { maxResults?: number },
): TextSearchMatch[] {
  const { maxResults } = options ?? {};
  const lines = content.split("\n");
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  const matches: TextSearchMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.toLowerCase();
    const matchesAllTokens = tokens.every((token) => lineLower.includes(token));

    if (matchesAllTokens) {
      const contextStart = Math.max(0, i - 2);
      const contextEnd = Math.min(lines.length, i + 3);
      const context = lines.slice(contextStart, contextEnd).join("\n");

      matches.push({
        snippet: line.trim(),
        line: i + 1,
        context,
      });

      if (maxResults && matches.length >= maxResults) {
        break;
      }
    }
  }

  return matches;
}
