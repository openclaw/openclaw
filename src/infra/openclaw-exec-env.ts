import type { SystemRunExecutionContext } from "../../packages/gateway-protocol/src/system-run-execution-context.js";

export const OPENCLAW_CLI_ENV_VAR = "OPENCLAW_CLI";

/** Child-shell routing hint; it does not authenticate or authorize a Gateway caller. */
export const SUBAGENT_EXEC_ENV_VAR = "OPENCLAW_SUBAGENT_EXEC";

const CLI_ENV_VALUE = "1";

export function markOpenClawExecEnv<T extends Record<string, string | undefined>>(env: T): T {
  return {
    ...env,
    [OPENCLAW_CLI_ENV_VAR]: CLI_ENV_VALUE,
  };
}

export function ensureOpenClawExecMarkerOnProcess(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  env[OPENCLAW_CLI_ENV_VAR] = CLI_ENV_VALUE;
  return env;
}

export function buildExecRoutingEnv(
  context?: SystemRunExecutionContext,
): Record<string, string> | undefined {
  const { senderId, chatId, subagent } = context ?? {};
  if (!senderId && !chatId && !subagent) {
    return undefined;
  }
  return {
    ...(senderId || chatId
      ? {
          OPENCLAW_CHANNEL_CONTEXT: JSON.stringify({
            ...(senderId ? { sender: { id: senderId } } : {}),
            ...(chatId ? { chat: { id: chatId } } : {}),
          }),
        }
      : {}),
    ...(subagent ? { [SUBAGENT_EXEC_ENV_VAR]: "1" } : {}),
  };
}
