export const OPENCLAW_CLI_ENV_VAR = "OPENCLAW_CLI";
export const OPENCLAW_CLI_ENV_VALUE = "1";
export function markOpenClawExecEnv(env) {
    return {
        ...env,
        [OPENCLAW_CLI_ENV_VAR]: OPENCLAW_CLI_ENV_VALUE,
    };
}
export function ensureOpenClawExecMarkerOnProcess(env = process.env) {
    env[OPENCLAW_CLI_ENV_VAR] = OPENCLAW_CLI_ENV_VALUE;
    return env;
}
