import fs from "node:fs";
import path from "node:path";

export const OPENCLAW_CLI_ENV_VAR = "OPENCLAW_CLI";
export const OPENCLAW_CLI_ENV_VALUE = "1";
export const OPENCLAW_CLI_PATH_ENV_VAR = "OPENCLAW_CLI_PATH";

export function resolveCurrentOpenClawCliPath(
  opts: {
    env?: NodeJS.ProcessEnv;
    argv?: string[];
    execPath?: string;
    cwd?: string;
    statSync?: (path: string) => fs.Stats;
  } = {},
): string | undefined {
  const env = opts.env ?? process.env;
  const envPath = env.OPENCLAW_CLI_PATH?.trim();
  if (envPath) {
    return envPath;
  }

  const statSync = opts.statSync ?? fs.statSync;
  const isFile = (candidate: string) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  };

  const execPath = opts.execPath ?? process.execPath;
  const execDir = path.dirname(execPath);
  const siblingCli = path.join(execDir, "openclaw");
  if (isFile(siblingCli)) {
    return siblingCli;
  }

  const argv = opts.argv ?? process.argv;
  const argvPath = argv[1];
  if (argvPath && isFile(argvPath)) {
    return argvPath;
  }

  const cwd = opts.cwd ?? process.cwd();
  for (const candidate of [
    path.join(cwd, "dist", "index.js"),
    path.join(cwd, "dist", "index.mjs"),
  ]) {
    if (isFile(candidate)) {
      return candidate;
    }
  }
  const binCli = path.join(cwd, "bin", "openclaw");
  if (isFile(binCli)) {
    return binCli;
  }

  return undefined;
}

export function markOpenClawExecEnv<T extends Record<string, string | undefined>>(env: T): T {
  const cliPath = resolveCurrentOpenClawCliPath({ env });
  return {
    ...env,
    [OPENCLAW_CLI_ENV_VAR]: OPENCLAW_CLI_ENV_VALUE,
    ...(cliPath ? { [OPENCLAW_CLI_PATH_ENV_VAR]: cliPath } : {}),
  };
}

export function ensureOpenClawExecMarkerOnProcess(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  env[OPENCLAW_CLI_ENV_VAR] = OPENCLAW_CLI_ENV_VALUE;
  const cliPath = resolveCurrentOpenClawCliPath({ env });
  if (cliPath) {
    env[OPENCLAW_CLI_PATH_ENV_VAR] = cliPath;
  }
  return env;
}
