export const MULLUSI_CLI_ENV_VAR = "MULLUSI_CLI";
export const MULLUSI_CLI_ENV_VALUE = "1";

export function markMullusiExecEnv<T extends Record<string, string | undefined>>(env: T): T {
  return {
    ...env,
    [MULLUSI_CLI_ENV_VAR]: MULLUSI_CLI_ENV_VALUE,
  };
}

export function ensureMullusiExecMarkerOnProcess(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  env[MULLUSI_CLI_ENV_VAR] = MULLUSI_CLI_ENV_VALUE;
  return env;
}
