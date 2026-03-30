export const NEXUS_CLI_ENV_VAR = "NEXUS_CLI";
export const NEXUS_CLI_ENV_VALUE = "1";

export function markOpenClawExecEnv<T extends Record<string, string | undefined>>(env: T): T {
  return {
    ...env,
    [NEXUS_CLI_ENV_VAR]: NEXUS_CLI_ENV_VALUE,
  };
}

export function ensureOpenClawExecMarkerOnProcess(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  env[NEXUS_CLI_ENV_VAR] = NEXUS_CLI_ENV_VALUE;
  return env;
}
