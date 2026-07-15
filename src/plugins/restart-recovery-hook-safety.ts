import { hasGlobalHooks } from "./hook-runner-global.js";

export const RESTART_RECOVERY_UNSAFE_REPLY_HOOKS = [
  "before_dispatch",
  "before_agent_reply",
  "before_agent_run",
  "before_message_write",
  "reply_dispatch",
] as const;

export function findRestartRecoveryUnsafeReplyHook(options?: {
  allowBeforeAgentReply?: boolean;
}): (typeof RESTART_RECOVERY_UNSAFE_REPLY_HOOKS)[number] | undefined {
  return RESTART_RECOVERY_UNSAFE_REPLY_HOOKS.find(
    (hookName) =>
      !(options?.allowBeforeAgentReply && hookName === "before_agent_reply") &&
      hasGlobalHooks(hookName),
  );
}
