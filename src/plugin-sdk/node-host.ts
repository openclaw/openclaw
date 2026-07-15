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

export function resolveExecutableFromPathEnv(
  executable: string,
  pathEnv: string,
  env: NodeJS.ProcessEnv | undefined,
  options: {
    includeExtensionless?: boolean;
    fallbackToLoginShell?: boolean;
    withPathEnv: true;
  },
): { executable: string; pathEnv?: string } | undefined;
export function resolveExecutableFromPathEnv(
  executable: string,
  pathEnv: string,
  env?: NodeJS.ProcessEnv,
  options?: {
    includeExtensionless?: boolean;
    fallbackToLoginShell?: boolean;
    withPathEnv?: false;
  },
): string | undefined;
export function resolveExecutableFromPathEnv(
  executable: string,
  pathEnv: string,
  env?: NodeJS.ProcessEnv,
  options?: {
    includeExtensionless?: boolean;
    fallbackToLoginShell?: boolean;
    withPathEnv?: boolean;
  },
): string | { executable: string; pathEnv?: string } | undefined {
  let resolution: { executable: string; pathEnv?: string } | undefined;
  if (!options?.fallbackToLoginShell) {
    const resolved = resolveExecutableFromPathEnvDirect(executable, pathEnv, env, options);
    resolution = resolved ? { executable: resolved } : undefined;
  } else {
    // Local catalog terminals launch with this same login-shell PATH. Carry it
    // forward because npm-style launchers may use `#!/usr/bin/env node`.
    const shellEnv = env ?? process.env;
    resolution = resolveExecutableFromUserShellPathWithPathEnv(executable, {
      env: shellEnv,
      pathEnv,
      includeExtensionless: options.includeExtensionless,
    });
  }
  return options?.withPathEnv ? resolution : resolution?.executable;
}
