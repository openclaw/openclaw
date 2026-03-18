// Legacy compat surface for external plugins that still depend on older
// broad plugin-sdk imports. Keep this file intentionally small.

const shouldWarnCompatImport =
  process.env.VITEST !== "true" &&
  process.env.NODE_ENV !== "test" &&
  process.env.OPENCLAW_SUPPRESS_PLUGIN_SDK_COMPAT_WARNING !== "1";

if (shouldWarnCompatImport) {
  process.emitWarning(
    "openclaw/plugin-sdk/compat is deprecated for new plugins. Migrate to focused openclaw/plugin-sdk/<subpath> imports.",
    {
      code: "OPENCLAW_PLUGIN_SDK_COMPAT_DEPRECATED",
      detail:
        "Bundled plugins must use scoped plugin-sdk subpaths. External plugins may keep compat temporarily while migrating.",
    },
  );
}

export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export { resolveControlCommandGate } from "../channels/command-gating.js";
export { delegateCompactionToRuntime } from "../context-engine/delegate.js";

export { createAccountStatusSink } from "./channel-lifecycle.js";
export { createPluginRuntimeStore } from "./runtime-store.js";
export { KeyedAsyncQueue } from "./keyed-async-queue.js";

export {
  createHybridChannelConfigAdapter,
  createHybridChannelConfigBase,
  createScopedAccountConfigAccessors,
  createScopedChannelConfigAdapter,
  createScopedChannelConfigBase,
  createScopedDmSecurityResolver,
  createTopLevelChannelConfigAdapter,
  createTopLevelChannelConfigBase,
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
} from "../../extensions/bluebubbles/src/group-policy.js";
export { collectBlueBubblesStatusIssues } from "../channels/plugins/status-issues/bluebubbles.js";
