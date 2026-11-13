// Host-enforced registration scopes accepted by api.on(name, handler, opts).
const PLUGIN_HOOK_AGENT_TRIGGERS = ["cron", "heartbeat", "user"] as const;

export type PluginHookAgentTrigger = (typeof PLUGIN_HOOK_AGENT_TRIGGERS)[number];

const pluginHookAgentTriggerSet = new Set<PluginHookAgentTrigger>(PLUGIN_HOOK_AGENT_TRIGGERS);

export const isPluginHookAgentTrigger = (trigger: unknown): trigger is PluginHookAgentTrigger =>
  typeof trigger === "string" && pluginHookAgentTriggerSet.has(trigger as PluginHookAgentTrigger);

export type PluginHookReplyDispatchKind = "agent" | "acp";

export const isPluginHookReplyDispatchKind = (kind: unknown): kind is PluginHookReplyDispatchKind =>
  kind === "agent" || kind === "acp";

export type PluginToolMatcher = readonly [string, ...string[]];

/** Registration options that limit when the host dispatches a typed hook. */
export type PluginHookRegistrationScopeOptions<K extends string> = (K extends "before_agent_reply"
  ? {
      /** Host-enforced turn triggers that may invoke this reply hook. */
      eligibleTriggers?: readonly [PluginHookAgentTrigger, ...PluginHookAgentTrigger[]];
    }
  : { eligibleTriggers?: never }) &
  (K extends "reply_dispatch"
    ? {
        /** Host-enforced dispatch paths that may invoke this hook; unknown paths remain eligible. */
        eligibleDispatchKinds?: readonly [
          PluginHookReplyDispatchKind,
          ...PluginHookReplyDispatchKind[],
        ];
      }
    : { eligibleDispatchKinds?: never }) &
  (K extends "reply_payload_sending" | "message_sending"
    ? {
        /** Host-enforced agents whose replies this hook governs; unknown agents remain eligible. */
        eligibleAgentIds?: readonly [string, ...string[]];
      }
    : { eligibleAgentIds?: never }) &
  (K extends "before_tool_call" | "after_tool_call"
    ? { matcher?: PluginToolMatcher }
    : { matcher?: never }) &
  (K extends "before_prompt_build"
    ? {
        /** Run only after the host has finalized the turn's policy-filtered tool surface. */
        requiresToolAuthority?: true;
      }
    : { requiresToolAuthority?: never });
