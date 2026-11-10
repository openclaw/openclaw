import { isPluginHookReplyDispatchKind, type PluginHookRegistration } from "./hook-types.js";

/** Whether a registration's declared dispatch kinds or triggers admit this hook context. */
export function isHookContextEligible(hook: PluginHookRegistration, ctx?: unknown): boolean {
  if (hook.hookName === "reply_dispatch" && hook.eligibleDispatchKinds !== undefined) {
    const kind =
      typeof ctx === "object" && ctx !== null && "dispatchKind" in ctx
        ? ctx.dispatchKind
        : undefined;
    // Unknown callers cannot prove exclusion from a hook, including during recovery checks.
    return !isPluginHookReplyDispatchKind(kind) || hook.eligibleDispatchKinds.includes(kind);
  }
  if (hook.hookName !== "before_agent_reply" || hook.eligibleTriggers === undefined) {
    return true;
  }
  const trigger =
    typeof ctx === "object" && ctx !== null && "trigger" in ctx ? ctx.trigger : undefined;
  return hook.eligibleTriggers.some((eligible) => eligible === trigger);
}
