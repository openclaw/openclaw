import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getPluginExecutionFrame } from "./plugin-instance-invocation.js";
import { getPluginRegistryState } from "./runtime-state.js";
import { recordPluginSdkDeprecationUsage } from "./sdk-deprecation-usage.js";

// Source imports and SDK bundles share the budget, including across plugin reloads.
const warned = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginSdkDeprecations"),
  () => new Set<string>(),
);

// Only these SQLite compatibility families have an approved final compatibility day.
const sqliteRemovalFamilies = new Set([
  "acp-session",
  "agent-end-side-effects",
  "agent-harness-host",
  "agent-harness-session-runtime-ownership",
  "agent-harness-tool-surface",
  "approval-event-publication",
  "approval-session-routing",
  "auth-profile-sync-operations",
  "auth-profiles",
  "channel-conversation-bindings",
  "channel-inbound-envelope",
  "channel-pairing-sync-allowlist",
  "codex-session-context",
  "command-authorization-sync",
  "conversation-bindings",
  "cron-store-path",
  "exec-approvals-sync-read",
  "github-publication",
  "memory-session",
  "memory-session-sync-inventory",
  "model-account-connect",
  "model-registry-native-read",
  "native-command-menu",
  "native-session-binding",
  "native-session-deletion",
  "node-host-sync-workspace",
  "openrouter-model-capabilities",
  "plugin-state-keyed-store",
  "provider-auth",
  "provider-selection",
  "provider-sync-configuration",
  "proxy-capture-reader",
  "proxy-capture-runtime",
  "proxy-capture-store",
  "reply-run-start",
  "reply-tool-authority-sync-preparation",
  "reply-visibility",
  "runtime-config",
  "session-catalog-identity",
  "session-catalog-title",
  "session-conversation",
  "session-deletion-transaction-callback",
  "session-entry-freshness",
  "session-input-completion",
  "session-model-override",
  "session-observer",
  "session-persistence",
  "session-store",
  "session-transcript",
  "session-transcript-key",
  "session-transcript-store",
  "session-upstream-links",
  "skill-command-discovery",
  "sqlite-runtime-native-access",
  "tool-surface",
  "tts",
  "watched-sessions-prompt",
  "watched-sessions-sync-harness-context",
  "web-search-providers",
]);

/** Call only at a legacy operation, with static capability and migration descriptions. */
export function warnPluginSdkDeprecation(params: {
  family: string;
  method: string;
  replacement: string;
  pluginId?: string;
  compatibility?: string;
  code?: string;
}): void {
  const frame = getPluginExecutionFrame();
  const candidate =
    params.pluginId ??
    frame?.invocation?.instance.pluginId ??
    getPluginRegistryState()?.registrationContext?.pluginId ??
    frame?.runtimePluginId;
  // An unscoped consumer must not turn a path or arbitrary label into a diagnostic.
  const pluginId =
    candidate &&
    candidate.length <= 128 &&
    /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/iu.test(candidate)
      ? candidate
      : undefined;
  const key = JSON.stringify([pluginId ?? null, params.family]);
  const removeAfter = sqliteRemovalFamilies.has(params.family) ? "2026-12-31" : undefined;
  if (pluginId) {
    recordPluginSdkDeprecationUsage(
      pluginId,
      `${params.family}:${params.method}`,
      params.method,
      params.replacement,
      removeAfter,
    );
  }
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  const removal = removeAfter
    ? "Final compatibility day: 2026-12-31. Removal ships in the first January 2027 stable release; no SDK major is required."
    : "Removal requires an announced ordinary stable release window.";
  process.emitWarning(
    `${pluginId ? `Plugin ${pluginId}` : "Plugin SDK"}: ${params.method} is deprecated; use ${params.replacement} instead. ${params.compatibility ?? "The legacy contract remains supported during its deprecation period."} ${removal}`,
    { code: params.code ?? "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
  );
}
