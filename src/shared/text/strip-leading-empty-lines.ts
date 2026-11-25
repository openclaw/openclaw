export function stripLeadingEmptyLines(text: string): string {
  return text.trim() ? text.replace(/^(?:[ \t]*\r?\n)+/, "") : "";
}
