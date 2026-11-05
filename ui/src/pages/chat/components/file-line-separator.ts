// Changed editor text uses the loaded file's separator when serialized for save.
export function detectLineSeparator(content: string): string | undefined {
  const match = content.match(/\r\n|\r|\n/);
  return match && match[0] !== "\n" ? match[0] : undefined;
}
