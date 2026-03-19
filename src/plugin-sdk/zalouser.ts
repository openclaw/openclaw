// Narrow plugin-sdk surface for the bundled zalouser plugin.
// Keep this list additive and scoped to symbols used under extensions/zalouser.

import { createOptionalChannelSetupSurface } from "./channel-setup.js";

export type { ReplyPayload } from "../auto-reply/types.js";
export { mergeAllowlist, summarizeMapping } from "../channels/allowlists/resolve-utils.js";
export { resolveMentionGatingWithBypass } from "../channels/mention-gating.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export {
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  setTopLevelChannelDmPolicyWithAllowFrom,
} from "../channels/plugins/setup-wizard-helpers.js";
export {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  migrateBaseNameToDefaultAccount,
  patchScopedAccountConfig,
} from "../channels/plugins/setup-helpers.js";
export { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelDirectoryEntry,
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  ChannelStatusIssue,
} from "../channels/plugins/types.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createChannelReplyPipeline } from "./channel-reply-pipeline.js";
export type { OpenClawConfig } from "../config/config.js";
export { isDangerousNameMatchingEnabled } from "../config/dangerous-name-matching.js";
export {
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
export type { GroupToolPolicyConfig, MarkdownTableMode } from "../config/types.js";
export { ToolPolicySchema } from "../config/zod-schema.agent-runtime.js";
export { MarkdownConfigSchema } from "../config/zod-schema.core.js";
export { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { AnyAgentTool, OpenClawPluginApi } from "../plugins/types.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export type { RuntimeEnv } from "../runtime.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { formatAllowFromLowercase } from "./allow-from.js";
export { resolveSenderCommandAuthorization } from "./command-auth.js";
export { resolveChannelAccountConfigBasePath } from "./config-paths.js";
export {
  evaluateGroupRouteAccessForPolicy,
  resolveSenderScopedGroupPolicy,
} from "./group-access.js";
export { loadOutboundMediaFromUrl } from "./outbound-media.js";
export { createChannelPairingController } from "./channel-pairing.js";
export { buildChannelSendResult } from "./channel-send-result.js";
export type { OutboundReplyPayload } from "./reply-payload.js";
export {
  deliverTextOrMediaReply,
  isNumericTargetId,
  resolveOutboundMediaUrls,
  resolveSendableOutboundReplyParts,
  sendMediaWithLeadingCaption,
  sendPayloadWithChunkedTextAndMedia,
} from "./reply-payload.js";
export { formatResolvedUnresolvedNote } from "./resolution-notes.js";
export { buildBaseAccountStatusSnapshot } from "./status-helpers.js";
export { chunkTextForOutbound } from "./text-chunking.js";

const zalouserSetup = createOptionalChannelSetupSurface({
  channel: "zalouser",
  label: "Zalo Personal",
  npmSpec: "@openclaw/zalouser",
  docsPath: "/channels/zalouser",
});

export const zalouserSetupAdapter = zalouserSetup.setupAdapter;
export const zalouserSetupWizard = zalouserSetup.setupWizard;
