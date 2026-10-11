/** One local family name, not a CSS list or a downloadable font URL. */
export function normalizeTerminalFontFamily(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const family = value.trim().replace(/\s+/g, " ");
  return family && family.length <= 100 && !/["\\;,{}<>\p{Cc}]/u.test(family) ? family : undefined;
}

const DEFAULT_TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", "OpenClaw Nerd Symbols", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export function terminalFontFamily(value?: string): string {
  const family = normalizeTerminalFontFamily(value);
  return family ? `"${family}", ${DEFAULT_TERMINAL_FONT_FAMILY}` : DEFAULT_TERMINAL_FONT_FAMILY;
}
