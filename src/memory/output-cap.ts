export function appendOutputWithCap(
  current: string,
  chunk: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const appended = current + chunk;
  if (appended.length <= maxChars) {
    return { text: appended, truncated: false };
  }
  // Keep the beginning of the stream so structured outputs (like JSON arrays)
  // retain their opening delimiters when capped.
  return { text: appended.slice(0, maxChars), truncated: true };
}
