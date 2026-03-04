// Narrow plugin-sdk surface for the bundled twitch plugin.
// Keep this list additive and scoped to symbols used under extensions/twitch.

export type { ReplyPayload } from "../auto-reply/types.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
} from "../channels/plugins/onboarding-types.js";
export { promptChannelAccessConfig } from "../channels/plugins/onboarding/channel-access.js";
export type { BaseProbeResult, ChannelStatusIssue } from "../channels/plugins/types.js";
export { createReplyPrefixOptions } from "../channels/reply-prefix.js";
export type { OpenClawConfig } from "../config/config.js";
export { MarkdownConfigSchema } from "../config/zod-schema.core.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { formatDocsLink } from "../terminal/links.js";
export type { WizardPrompter } from "../wizard/prompts.js";
