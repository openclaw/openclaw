import { resolveExecutableFromPathEnv as resolveExecutableFromPathEnvDirect } from "../infra/executable-path.js";
import { resolveExecutableFromUserShellPathWithPathEnv } from "../infra/shell-env.js";

export {
  decodeNodePtyResumeParams,
  runNodePtyCommand,
  type NodePtyCommandResult,
  type NodePtyResumeParams,
} from "../node-host/pty-command.js";
export { validateClaudeSessionId } from "../node-host/invoke-agent-cli-claude-params.js";
export type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";

export type ExecutablePathEnvResolution = {
  executable: string;
  /** PATH required by an env-based interpreter when login-shell fallback was used. */
  pathEnv?: string;
};

export function resolveExecutableWithPathEnv(
  executable: string,
  pathEnv: string,
  env?: NodeJS.ProcessEnv,
  options?: { includeExtensionless?: boolean; fallbackToLoginShell?: boolean },
): ExecutablePathEnvResolution | undefined {
  if (!options?.fallbackToLoginShell) {
    const resolved = resolveExecutableFromPathEnvDirect(executable, pathEnv, env, options);
    return resolved ? { executable: resolved } : undefined;
  }
  // Local catalog terminals launch with this same login-shell PATH. Carry it
  // forward because npm-style launchers may use `#!/usr/bin/env node`.
  const shellEnv = env ?? process.env;
  return resolveExecutableFromUserShellPathWithPathEnv(executable, {
    env: shellEnv,
    pathEnv,
    includeExtensionless: options.includeExtensionless,
  });
}

export function resolveExecutableFromPathEnv(
  executable: string,
  pathEnv: string,
  env?: NodeJS.ProcessEnv,
  options?: { includeExtensionless?: boolean; fallbackToLoginShell?: boolean },
): string | undefined {
  return resolveExecutableWithPathEnv(executable, pathEnv, env, options)?.executable;
}
