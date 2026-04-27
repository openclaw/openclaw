export { PLUGIN_PROMPT_MUTATION_RESULT_FIELDS, stripPromptMutationFieldsFromLegacyHookResult, } from "./hook-before-agent-start.types.js";
export const PLUGIN_HOOK_NAMES = [
    "before_model_resolve",
    "before_prompt_build",
    "before_agent_start",
    "before_agent_reply",
    "model_call_started",
    "model_call_ended",
    "llm_input",
    "llm_output",
    "agent_end",
    "before_compaction",
    "after_compaction",
    "before_reset",
    "inbound_claim",
    "message_received",
    "message_sending",
    "message_sent",
    "before_tool_call",
    "after_tool_call",
    "tool_result_persist",
    "before_message_write",
    "session_start",
    "session_end",
    "subagent_spawning",
    "subagent_delivery_target",
    "subagent_spawned",
    "subagent_ended",
    "gateway_start",
    "gateway_stop",
    "before_dispatch",
    "reply_dispatch",
    "before_install",
];
const assertAllPluginHookNamesListed = true;
void assertAllPluginHookNamesListed;
const pluginHookNameSet = new Set(PLUGIN_HOOK_NAMES);
export const isPluginHookName = (hookName) => typeof hookName === "string" && pluginHookNameSet.has(hookName);
export const PROMPT_INJECTION_HOOK_NAMES = [
    "before_prompt_build",
    "before_agent_start",
];
const promptInjectionHookNameSet = new Set(PROMPT_INJECTION_HOOK_NAMES);
export const isPromptInjectionHookName = (hookName) => promptInjectionHookNameSet.has(hookName);
export const CONVERSATION_HOOK_NAMES = [
    "llm_input",
    "llm_output",
    "agent_end",
];
const conversationHookNameSet = new Set(CONVERSATION_HOOK_NAMES);
export const isConversationHookName = (hookName) => conversationHookNameSet.has(hookName);
export const PluginApprovalResolutions = {
    ALLOW_ONCE: "allow-once",
    ALLOW_ALWAYS: "allow-always",
    DENY: "deny",
    TIMEOUT: "timeout",
    CANCELLED: "cancelled",
};
