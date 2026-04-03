// Pure channel contract types used by plugin implementations and tests.
export type {
  BaseProbeResult,
  BaseTokenResolution,
  ChannelAgentTool,
  ChannelAccountSnapshot,
  ChannelApprovalAdapter,
  ChannelApprovalCapability,
  ChannelCommandConversationContext,
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionDiscoveryContext,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
  ChannelStatusIssue,
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "../channels/plugins/types.js";

export type { ChannelDirectoryAdapter } from "../channels/plugins/types.adapters.js";
