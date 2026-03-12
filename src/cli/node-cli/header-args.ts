/**
 * Parse repeatable --header "Name: value" strings into a record.
 * @throws if any entry does not contain ":" (invalid format).
 */
export function parseHeaderArgs(headerStrings: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headerStrings?.length) {
    return out;
  }
  for (const raw of headerStrings) {
    const s = typeof raw === "string" ? raw.trim() : "";
    const idx = s.indexOf(":");
    if (idx < 0) {
      throw new Error(`Invalid --header: must be "Name: value", got: ${JSON.stringify(raw)}`);
    }
    const key = s.slice(0, idx).trim();
    if (!key) {
      throw new Error(
        `Invalid --header: header name must be non-empty, got: ${JSON.stringify(raw)}`,
      );
    }
    const value = s.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}
