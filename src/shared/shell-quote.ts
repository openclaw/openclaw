/** Quotes a literal POSIX shell argument, including empty strings and apostrophes. */
export function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Preserves backslash-style quoting in operator-visible command strings. */
export function shellEscapeBackslash(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
