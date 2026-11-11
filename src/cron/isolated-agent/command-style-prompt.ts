const COMMAND_STYLE_CRON_PREFIX =
  /^(?:(?:[A-Z_][A-Z0-9_]*=\S+\s+)+)?(?:cd\s+\S+|(?:\.{1,2}|~)?\/\S+|[A-Za-z]:[\\/]\S+|(?:bash|bun|cargo|deno|docker|gh|git|go|make|node|npm|npx|pnpm|python|python3|ruby|sh|tsx|uv|zsh)\b)/u;

/** Detects single-line cron prompts that look like shell commands or command invocations. */
export function isCommandStyleCronMessage(message: string): boolean {
  return !message.trim().includes("\n") && COMMAND_STYLE_CRON_PREFIX.test(message.trim());
}
