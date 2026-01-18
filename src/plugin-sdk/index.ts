export { CHANNEL_MESSAGE_ACTION_NAMES } from "../channels/plugins/message-action-names.js";
export type {
  ChannelAccountSnapshot,
  ChannelAccountState,
  ChannelAgentTool,
  ChannelAgentToolFactory,
  ChannelAuthAdapter,
  ChannelCapabilities,
  ChannelCommandAdapter,
  ChannelConfigAdapter,
  ChannelDirectoryAdapter,
  ChannelDirectoryEntry,
  ChannelDirectoryEntryKind,
  ChannelElevatedAdapter,
  ChannelGatewayAdapter,
  ChannelGatewayContext,
  ChannelGroupAdapter,
  ChannelGroupContext,
  ChannelHeartbeatAdapter,
  ChannelHeartbeatDeps,
  ChannelId,
  ChannelLogSink,
  ChannelLoginWithQrStartResult,
  ChannelLoginWithQrWaitResult,
  ChannelLogoutContext,
  ChannelLogoutResult,
  ChannelMentionAdapter,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelMessagingAdapter,
  ChannelMeta,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelOutboundTargetMode,
  ChannelPairingAdapter,
  ChannelPollContext,
  ChannelPollResult,
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelResolverAdapter,
  ChannelSecurityAdapter,
  ChannelSecurityContext,
  ChannelSecurityDmPolicy,
  ChannelSetupAdapter,
  ChannelSetupInput,
  ChannelStatusAdapter,
  ChannelStatusIssue,
  ChannelStreamingAdapter,
  ChannelThreadingAdapter,
  ChannelThreadingContext,
  ChannelThreadingToolContext,
  ChannelToolSend,
} from "../channels/plugins/types.js";
export type { ChannelConfigSchema, ChannelPlugin } from "../channels/plugins/types.plugin.js";

export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export { applyAccountNameToChannelSection } from "../channels/plugins/setup-helpers.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";

export type { ChannelOnboardingAdapter } from "../channels/plugins/onboarding-types.js";
export { addWildcardAllowFrom } from "../channels/plugins/onboarding/helpers.js";
export { promptChannelAccessConfig } from "../channels/plugins/onboarding/channel-access.js";

export {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "../agents/tools/common.js";

export { formatDocsLink } from "../terminal/links.js";
