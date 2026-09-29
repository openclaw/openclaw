/** Process env key that marks child commands as launched by the OpenClaw CLI. */
export const OPENCLAW_CLI_ENV_VAR = "OPENCLAW_CLI";

/** Child-shell routing hint; it does not authenticate or authorize a Gateway caller. */
export const SUBAGENT_EXEC_ENV_VAR = "OPENCLAW_SUBAGENT_EXEC";

/** Stable marker value used for OpenClaw-launched subprocess detection. */
const CLI_ENV_VALUE = "1";

/** Returns a cloned env object with the OpenClaw CLI marker set. */
export function markOpenClawExecEnv<T extends Record<string, string | undefined>>(
  /** Source environment to clone before adding the subprocess marker. */
  env: T,
): T {
  return {
    ...env,
    [OPENCLAW_CLI_ENV_VAR]: CLI_ENV_VALUE,
  };
}

/** Mutates an existing process env object so current-process children inherit the marker. */
export function ensureOpenClawExecMarkerOnProcess(
  /** Process env object to mutate; defaults to the current process environment. */
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  env[OPENCLAW_CLI_ENV_VAR] = CLI_ENV_VALUE;
  return env;
}
