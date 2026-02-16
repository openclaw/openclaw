/**
 * Adaptive SSH Environment Wrapper
 * Provides self-healing PATH and environment discovery for remote command execution.
 */

export const ARE_PREAMBLE = `
# Adaptive Remote Executor Preamble
[ -f /etc/profile ] && . /etc/profile
[ -f ~/.profile ] && . ~/.profile
SEARCH_PATHS="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/Library/pnpm:$HOME/.pnpm-global/bin:$HOME/.local/bin"
if [ "$(uname -s)" = "Darwin" ]; then
    PW_NODE=$(ls -d $HOME/Library/Caches/ms-playwright-go/*/node 2>/dev/null | head -n 1)
    [ -n "$PW_NODE" ] && SEARCH_PATHS="$SEARCH_PATHS:$(dirname "$PW_NODE")"
fi
export PATH=$(echo "$SEARCH_PATHS:$PATH" | tr ':' '\\n' | awk '!x[$0]++' | tr '\\n' ':' | sed 's/:$//')
`.trim();

/**
 * Wraps a shell command with the ARE preamble.
 */
export function wrapAdaptiveCommand(command: string): string {
  return `${ARE_PREAMBLE}\n${command}`;
}
