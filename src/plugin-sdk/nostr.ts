// Private helper surface for the bundled nostr plugin.
// Keep this list additive and scoped to the bundled Nostr surface.

import { createOptionalChannelSetupSurface } from "./channel-setup.js";

export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createChannelReplyPipeline } from "./channel-reply-pipeline.js";
export {
  createDirectDmPreCryptoGuardPolicy,
  dispatchInboundDirectDmWithRuntime,
  type DirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicyOverrides,
} from "./direct-dm.js";
export {
  createPreCryptoDirectDmAuthorizer,
  resolveInboundDirectDmAccessWithRuntime,
} from "./direct-dm.js";
export type { OpenClawConfig } from "../config/config.js";
export { MarkdownConfigSchema } from "../config/zod-schema.core.js";
export { readJsonBodyWithLimit, requestBodyErrorToText } from "../infra/http-body.js";
export { isBlockedHostnameOrIp } from "../infra/net/ssrf.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
export {
  buildComputedAccountStatusSnapshot,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
} from "./status-helpers.js";
export { createFixedWindowRateLimiter } from "./webhook-memory-guards.js";
export { mapAllowFromEntries } from "./channel-config-helpers.js";

const nostrSetup = createOptionalChannelSetupSurface({
  channel: "nostr",
  label: "Nostr",
  npmSpec: "@openclaw/nostr",
  docsPath: "/channels/nostr",
});

export const nostrSetupAdapter = nostrSetup.setupAdapter;
export const nostrSetupWizard = nostrSetup.setupWizard;
