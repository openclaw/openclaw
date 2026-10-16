// Host-enforced hook registration scope. hook-types.ts re-exports the vocabulary types.
const PLUGIN_HOOK_AGENT_TRIGGERS = ["cron", "heartbeat", "user"] as const;

export type PluginHookAgentTrigger = (typeof PLUGIN_HOOK_AGENT_TRIGGERS)[number];

export type PluginHookReplyDispatchKind = "agent" | "acp";

type ScopedHookRegistration = {
  hookName: string;
  eligibleTriggers?: readonly PluginHookAgentTrigger[];
  eligibleDispatchKinds?: readonly PluginHookReplyDispatchKind[];
  eligibleChannels?: readonly string[];
};

const pluginHookAgentTriggerSet = new Set<PluginHookAgentTrigger>(PLUGIN_HOOK_AGENT_TRIGGERS);

export const isPluginHookAgentTrigger = (trigger: unknown): trigger is PluginHookAgentTrigger =>
  // SAFETY: Set.has compares by value, so any other string returns false.
  typeof trigger === "string" && pluginHookAgentTriggerSet.has(trigger as PluginHookAgentTrigger);

export const isPluginHookReplyDispatchKind = (kind: unknown): kind is PluginHookReplyDispatchKind =>
  kind === "agent" || kind === "acp";

/** Canonical channel-provider identifier, not a conversation or transport target ID. */
export const isPluginHookChannelId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9_-]*$/.test(value);

/** Applies a registration's host-enforced scope to the caller's hook context. */
export function isHookContextEligible(hook: ScopedHookRegistration, ctx?: unknown): boolean {
  if (
    (hook.hookName === "reply_payload_sending" || hook.hookName === "message_sending") &&
    hook.eligibleChannels !== undefined
  ) {
    const channelId =
      typeof ctx === "object" && ctx !== null && "channelId" in ctx ? ctx.channelId : undefined;
    // Missing/noncanonical context cannot prove exclusion, including preview safety checks.
    return !isPluginHookChannelId(channelId) || hook.eligibleChannels.includes(channelId);
  }
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
    typeof ctx === "object" && ctx !== null && "trigger" in ctx
      ? (ctx as { trigger?: unknown }).trigger // SAFETY: `in` proved the field; value stays unknown.
      : undefined;
  return (
    // SAFETY: includes compares by value, so any other string returns false.
    typeof trigger === "string" && hook.eligibleTriggers.includes(trigger as PluginHookAgentTrigger)
  );
}
