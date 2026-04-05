export const OPENCLAW_CLI_ENV_VAR = "OPENCLAW_CLI";
export const OPENCLAW_CLI_ENV_VALUE = "1";
export const OPENCLAW_EXEC_GATEWAY_IDENTITY_ENV_VARS = ["OPENCLAW_SERVICE_KIND"] as const;

export function markOpenClawExecEnv<T extends Record<string, string | undefined>>(env: T): T {
  return {
    ...env,
    [OPENCLAW_CLI_ENV_VAR]: OPENCLAW_CLI_ENV_VALUE,
  };
}

// Exec children should not inherit the gateway-only credential precedence signal,
// but restart/update flows still need supervisor-name overrides.
export function stripOpenClawExecGatewayIdentityEnv<T extends Record<string, string | undefined>>(
  env: T,
): T {
  const stripped = { ...env };
  for (const key of OPENCLAW_EXEC_GATEWAY_IDENTITY_ENV_VARS) {
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
