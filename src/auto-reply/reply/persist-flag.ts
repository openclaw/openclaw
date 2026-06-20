// Parses the explicit --persist flag used by session preference commands.

const PERSIST_FLAG_PATTERN = /(?:^|\s)--persist(?=$|\s)/i;

export function extractPersistFlag(body: string): { cleaned: string; persist: boolean } {
  const match = body.match(PERSIST_FLAG_PATTERN);
  if (!match || match.index === undefined) {
    return { cleaned: body.trim(), persist: false };
  }
  const start = match.index;
  const leadingWhitespace = match[0].startsWith(" ") ? 1 : 0;
  const flagStart = start + leadingWhitespace;
  const flagEnd = flagStart + "--persist".length;
  const cleaned = `${body.slice(0, flagStart)} ${body.slice(flagEnd)}`.replace(/\s+/g, " ").trim();
  return { cleaned, persist: true };
}
