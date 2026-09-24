// Saves must round-trip the file's original bytes, so CRLF/CR files configure
// CodeMirror's line separator instead of silently normalizing to LF on save.
export function detectLineSeparator(content: string): string | undefined {
  const match = content.match(/\r\n|\r|\n/);
  return match && match[0] !== "\n" ? match[0] : undefined;
}
