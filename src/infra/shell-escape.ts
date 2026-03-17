/**
 * Single-quote shell-escape for POSIX sh/bash/zsh.
 * Wraps s in single quotes and escapes any embedded single quotes.
 * e.g. "it's a test" → "'it'\\''s a test'"
 */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
