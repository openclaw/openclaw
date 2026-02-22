/**
 * Adaptive SSH Environment Wrapper
 * Provides self-healing PATH and environment discovery for remote command execution.
 */

export const ARE_PREAMBLE = [
  "# Adaptive Remote Executor Preamble",
  '[ -f /etc/profile ] && . /etc/profile',
  '[ -f ~/.profile ] && . ~/.profile',
  'SEARCH_PATHS="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/Library/pnpm:$HOME/.pnpm-global/bin:$HOME/.local/bin"',
  'if [ "$(uname -s)" = "Darwin" ]; then',
  '    PW_NODE=$(ls -d $HOME/Library/Caches/ms-playwright-go/*/node 2>/dev/null | head -n 1)',
  '    [ -n "$PW_NODE" ] && SEARCH_PATHS="$SEARCH_PATHS:$(dirname "$PW_NODE")"',
  "fi",
  "export PATH=$(echo \"$SEARCH_PATHS:$PATH\" | tr ':' '\\n' | awk '!x[$0]++' | tr '\\n' ':' | sed 's/:$//')",
].join("\n");

/**
 * Wraps a shell command with the ARE preamble so that common binary
 * locations are available in the remote PATH.
 *
 * **Security note:** `command` is concatenated into a shell script without
 * escaping. Callers MUST ensure the value is trusted (i.e. constructed
 * internally, never from raw user input). This mirrors the existing
 * `spawn("/usr/bin/ssh", ...)` pattern used elsewhere in the codebase
 * where the command string is always built by OpenClaw itself.
 */
export function wrapAdaptiveCommand(command: string): string {
  return `${ARE_PREAMBLE}\n${command}`;
}
