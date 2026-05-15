/**
 * @deprecated Compatibility facade for older Feishu/Lark channel packages that
 * imported pairing helpers from `openclaw/plugin-sdk/feishu`.
 * New plugins should use generic channel SDK subpaths instead.
 */
export type { ChannelPlugin } from "./channel-core.js";
export type { OpenClawConfig } from "./config-types.js";
export type { OpenClawPluginApi, PluginRuntime } from "./channel-plugin-common.js";

export {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  emptyPluginConfigSchema,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
} from "./channel-plugin-common.js";
export { createScopedPairingAccess } from "./pairing-access.js";
export { issuePairingChallenge } from "../pairing/pairing-challenge.js";
