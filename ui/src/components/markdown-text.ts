const BLOCK_ART_LINE_RE = /^[\t \u00a0▀▄█]+$/u;
const BLOCK_ART_GLYPH_RE = /[▀▄█]/u;

export function normalizeMarkdownLineBreaks(value: string): string {
  // Most streamed text already uses LF. Avoid allocating a second full string
  // and running the WebKit regexp engine when there is nothing to normalize.
  if (!value.includes("\r") && !value.includes("\u2028") && !value.includes("\u2029")) {
    return value;
  }
  return value.replace(/\r\n?|[\u2028\u2029]/g, "\n");
}

export function isMarkdownBlockArtText(value: string): boolean {
  if (!BLOCK_ART_GLYPH_RE.test(value)) {
    return false;
  }
  const artLines = normalizeMarkdownLineBreaks(value)
    .split("\n")
    .filter((line) => line.trim().length > 0);

  // QR generators commonly use spaces plus upper/lower/full block glyphs.
  // Require multiple glyph-only lines so ordinary prose with a stray block character stays markdown.
  return (
    artLines.length >= 2 &&
    artLines.every((line) => BLOCK_ART_LINE_RE.test(line) && BLOCK_ART_GLYPH_RE.test(line)) &&
    value.match(/[▀▄█]/gu)!.length >= 8
  );
}
