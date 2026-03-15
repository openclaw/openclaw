// Narrow plugin-sdk surface for the bundled identity-memory plugin.

export type { OpenClawPluginApi } from "../plugins/types.js";
export type {
  PluginHookMessageReceivedEvent,
  PluginHookMessageContext,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginCommandContext,
} from "../plugins/types.js";
