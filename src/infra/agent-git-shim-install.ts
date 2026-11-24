import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { AGENT_GIT_SANDBOX_SCRIPT, AGENT_GIT_SHIM, RESOLVE_AGENT_GIT } from "./agent-git-shim.js";

/** Install in the filesystem where Git executes, including each private container. */
export function buildAgentGitShimInstallCommand(binDir: string, source?: string): string {
  return `set -e
wrapper_bin=${quoteCliArg(binDir)}
git=$(${RESOLVE_AGENT_GIT})
command -p mkdir -p -- "$wrapper_bin"
temporary=$(command -p mktemp "$wrapper_bin/git.XXXXXXXX")
trap 'command -p rm -f -- "$temporary"' 0
{
  printf '#!/bin/sh\\ngit="'
  printf '%s' "$git" | command -p sed 's/[\\\\$\`"]/\\\\&/g'
  printf '"\\n'
  ${
    source
      ? `command -p tail -n +3 ${quoteCliArg(source)}`
      : `command -p cat <<'AGENT_GIT_BODY'
${AGENT_GIT_SHIM}
AGENT_GIT_BODY`
  }
} > "$temporary"
command -p chmod 755 "$temporary" "$wrapper_bin"
command -p mv -f -- "$temporary" "$wrapper_bin/git"
${
  source
    ? ""
    : `# The executable resource mount sources preparation output from noexec /tmp.
command -p mkdir -p -- "$wrapper_bin/container"
temporary=$(command -p mktemp "$wrapper_bin/container/git.XXXXXXXX")
printf '%s\\n' '#!/bin/sh' '. ${AGENT_GIT_SANDBOX_SCRIPT}' > "$temporary"
command -p chmod 755 "$temporary" "$wrapper_bin/container"
command -p mv -f -- "$temporary" "$wrapper_bin/container/git"`
}
trap - 0
`;
}
