// Legacy compat surface for external plugins that still depend on older
// broad plugin-sdk imports. Keep this file intentionally small.

export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export { resolveControlCommandGate } from "../channels/command-gating.js";

export { createAccountStatusSink } from "./channel-lifecycle.js";
export { createPluginRuntimeStore } from "./runtime-store.js";
export { KeyedAsyncQueue } from "./keyed-async-queue.js";

export {
  createScopedAccountConfigAccessors,
  createScopedChannelConfigBase,
  createScopedDmSecurityResolver,
  mapAllowFromEntries,
} from "./channel-config-helpers.js";
export { formatAllowFromLowercase, formatNormalizedAllowFromEntries } from "./allow-from.js";
export * from "./channel-config-schema.js";
export * from "./channel-policy.js";
export * from "./reply-history.js";
export * from "./directory-runtime.js";
export { mapAllowlistResolutionInputs } from "./allowlist-resolution.js";

export {
  resolveBlueBubblesGroupRequireMention,
  resolveBlueBubblesGroupToolPolicy,
} from "../channels/plugins/group-mentions.js";
export { collectBlueBubblesStatusIssues } from "../channels/plugins/status-issues/bluebubbles.js";
