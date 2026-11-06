/** Keeps Markdown image prefixes out of bash shorthand. */
export function isBangCommandInput(text?: string): boolean {
  const body = text?.trimStart() ?? "";
  return body.startsWith("!") && !/^!\[[^\r\n]*\](?:\(|\[)/.test(body);
}
