export const OPENCLAW_CLI_ENV_VAR = "OPENCLAW_CLI";
export const OPENCLAW_CLI_ENV_VALUE = "1";
export const NO_DNA_ENV_VAR = "NO_DNA";
export const NO_DNA_ENV_VALUE = "1";

export function markOpenClawCliEnv<T extends Record<string, string | undefined>>(env: T): T {
  return {
    ...env,
    [OPENCLAW_CLI_ENV_VAR]: OPENCLAW_CLI_ENV_VALUE,
  };
}

export function markOpenClawChildCommandEnv<T extends Record<string, string | undefined>>(
  env: T,
): T {
  return {
    ...markOpenClawCliEnv(env),
    [NO_DNA_ENV_VAR]: NO_DNA_ENV_VALUE,
  };
}

export function ensureOpenClawExecMarkerOnProcess(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  env[OPENCLAW_CLI_ENV_VAR] = OPENCLAW_CLI_ENV_VALUE;
  return env;
}
