export const OPENCLAW_CLI_ENV_VAR = "OPENCLAW_CLI";
export const OPENCLAW_CLI_ENV_VALUE = "1";
export const OPENCLAW_AGENT_ID_ENV_VAR = "OPENCLAW_AGENT_ID";
export const AGENT_NAME_ENV_VAR = "AGENT_NAME";

export function markOpenClawExecEnv<T extends Record<string, string | undefined>>(env: T): T {
  return {
    ...env,
    [OPENCLAW_CLI_ENV_VAR]: OPENCLAW_CLI_ENV_VALUE,
  };
}

export function markOpenClawAgentExecEnv<T extends Record<string, string | undefined>>(
  env: T,
  agentId: string | undefined,
): T {
  if (!agentId) return env;
  env[OPENCLAW_AGENT_ID_ENV_VAR] = agentId;
  if (!env[AGENT_NAME_ENV_VAR]) env[AGENT_NAME_ENV_VAR] = agentId;
  return env;
}

export function ensureOpenClawExecMarkerOnProcess(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  env[OPENCLAW_CLI_ENV_VAR] = OPENCLAW_CLI_ENV_VALUE;
  return env;
}
