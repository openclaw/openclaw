export const OPENCLAW_CLI_ENV_VAR = "OPENCLAW_CLI";
export const OPENCLAW_CLI_ENV_VALUE = "1";
export const OPENCLAW_SERVICE_RUNTIME_ENV_VARS = [
  "OPENCLAW_LAUNCHD_LABEL",
  "OPENCLAW_SYSTEMD_UNIT",
  "OPENCLAW_WINDOWS_TASK_NAME",
  "OPENCLAW_SERVICE_MARKER",
  "OPENCLAW_SERVICE_KIND",
  "OPENCLAW_SERVICE_VERSION",
] as const;

export function markOpenClawExecEnv<T extends Record<string, string | undefined>>(env: T): T {
  return {
    ...env,
    [OPENCLAW_CLI_ENV_VAR]: OPENCLAW_CLI_ENV_VALUE,
  };
}

export function stripOpenClawServiceRuntimeEnv<T extends Record<string, string | undefined>>(
  env: T,
): T {
  const stripped = { ...env };
  for (const key of OPENCLAW_SERVICE_RUNTIME_ENV_VARS) {
    delete stripped[key as keyof T];
  }
  return stripped;
}

export function ensureOpenClawExecMarkerOnProcess(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  env[OPENCLAW_CLI_ENV_VAR] = OPENCLAW_CLI_ENV_VALUE;
  return env;
}
