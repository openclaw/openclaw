export type ParsedMcpToolName = {
  server: string;
  tool: string;
};

/**
 * Parse an Anthropic-style MCP tool name: `mcp__{server}__{tool}`.
 *
 * Notes:
 * - We split on the first `__` after the `mcp__` prefix so tool names that
 *   contain `__` remain intact.
 */
export function parseMcpToolName(raw: string): ParsedMcpToolName | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (!trimmed.startsWith("mcp__")) {
    return null;
  }

  const rest = trimmed.slice("mcp__".length);
  const idx = rest.indexOf("__");
  if (idx <= 0) {
    return null;
  }

  const server = rest.slice(0, idx).trim();
  const tool = rest.slice(idx + 2).trim();
  if (!server || !tool) {
    return null;
  }

  return { server, tool };
}

export function formatMcpToolNameForLog(raw: string): string | null {
  const parsed = parseMcpToolName(raw);
  if (!parsed) {
    return null;
  }
  return `${parsed.server}:${parsed.tool}`;
}

export function formatMcpToolNamesForLog(
  rawNames: string[],
  options?: { max?: number; maxChars?: number },
): { formatted: string[]; truncated: boolean; remaining: number } {
  const max = options?.max ?? 60;
  const maxChars = options?.maxChars ?? 2_000;

  const formatted = Array.from(
    new Set(
      rawNames
        .map((n) => formatMcpToolNameForLog(n))
        .filter((n): n is string => typeof n === "string" && n.length > 0),
    ),
  ).toSorted();

  if (formatted.length <= max) {
    const joined = formatted.join(",");
    if (joined.length <= maxChars) {
      return { formatted, truncated: false, remaining: 0 };
    }

    // Char-based truncation.
    const out: string[] = [];
    let used = 0;
    for (const name of formatted) {
      const add = out.length === 0 ? name.length : name.length + 1; // + comma
      if (used + add > maxChars) {
        break;
      }
      out.push(name);
      used += add;
    }
    return {
      formatted: out,
      truncated: out.length < formatted.length,
      remaining: formatted.length - out.length,
    };
  }

  // Count-based truncation.
  const out = formatted.slice(0, max);
  return { formatted: out, truncated: true, remaining: formatted.length - out.length };
}
