// ─── Type re-exports (channel plugin contract) ─────────────────────────────
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export type { ChannelCapabilities, ChannelMeta } from "../channels/plugins/types.core.js";
export type {
  ChannelConfigAdapter,
  ChannelOutboundAdapter,
  ChannelSetupAdapter,
} from "../channels/plugins/types.js";
export type { ChannelSetupWizardAdapter } from "../channels/plugins/setup-wizard-types.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawConfig } from "../config/config.js";
export type { OpenClawPluginApi } from "../plugins/types.js";

// ─── Value re-exports (shared channel helpers) ─────────────────────────────
export { DEFAULT_ACCOUNT_ID } from "../channels/channel-config-helpers.js";
export { buildChannelConfigSchema } from "../channels/plugins/channel-config-schema.js";
export { emptyPluginConfigSchema } from "../channels/plugins/channel-config-schema.js";