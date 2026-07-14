import { resolveExecutableFromPathEnv as resolveExecutableFromPathEnvDirect } from "../infra/executable-path.js";
import { resolveExecutableFromUserShellPath } from "../infra/shell-env.js";

export {
  decodeNodePtyResumeParams,
  runNodePtyCommand,
  type NodePtyCommandResult,
  type NodePtyResumeParams,
} from "../node-host/pty-command.js";
export { validateClaudeSessionId } from "../node-host/invoke-agent-cli-claude-params.js";
export type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";

export function resolveExecutableFromPathEnv(
  executable: string,
  pathEnv: string,
  env?: NodeJS.ProcessEnv,
  options?: { includeExtensionless?: boolean; fallbackToLoginShell?: boolean },
): string | undefined {
  if (!options?.fallbackToLoginShell) {
    return resolveExecutableFromPathEnvDirect(executable, pathEnv, env, options);
  }
  // Local catalog terminals launch inside this same login shell. Checking its
  // PATH avoids rejecting CLIs installed by Homebrew, npm, or user installers.
  const shellEnv = env ?? process.env;
  return resolveExecutableFromUserShellPath(executable, {
    env: shellEnv,
    pathEnv,
    includeExtensionless: options.includeExtensionless,
  });
}
