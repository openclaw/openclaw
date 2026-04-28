import pluginSdkEntryList from "../../scripts/lib/plugin-sdk-entrypoints.json" with { type: "json" };

export const pluginSdkEntrypoints = [...pluginSdkEntryList];

export const pluginSdkSubpaths = pluginSdkEntrypoints.filter((entry) => entry !== "index");

// Transitional compatibility/helper surfaces owned by their matching bundled plugin.
// Cross-owner extension imports are blocked by the package contract guardrails.
export const reservedBundledPluginSdkEntrypoints = [
  "bluebubbles",
  "bluebubbles-policy",
  "browser-cdp",
  "browser-config-runtime",
  "browser-config-support",
  "browser-control-auth",
  "browser-node-runtime",
  "browser-profiles",
  "browser-security-runtime",
  "browser-setup-tools",
  "browser-support",
  "diagnostics-otel",
  "diagnostics-prometheus",
  "diffs",
  "feishu",
  "feishu-conversation",
  "feishu-setup",
  "github-copilot-login",
  "github-copilot-token",
  "googlechat",
  "googlechat-runtime-shared",
  "irc",
  "irc-surface",
  "line",
  "line-core",
  "line-runtime",
  "line-surface",
  "llm-task",
  "matrix",
  "matrix-helper",
  "matrix-runtime-heavy",
  "matrix-runtime-shared",
  "matrix-runtime-surface",
  "matrix-surface",
  "matrix-thread-bindings",
  "mattermost",
  "mattermost-policy",
  "memory-core",
  "memory-lancedb",
  "msteams",
  "nextcloud-talk",
  "nostr",
  "opencode",
  "telegram-command-ui",
  "thread-ownership",
  "tlon",
  "twitch",
  "voice-call",
  "zalo",
  "zalo-setup",
  "zalouser",
] as const;

export type DormantReservedBundledPluginSdkEntrypointReason =
  | "bundled-plugin-compat"
  | "external-compat"
  | "owner-facade-compat";

export type DormantReservedBundledPluginSdkEntrypointRecord = {
  subpath: string;
  owner: string;
  reason: DormantReservedBundledPluginSdkEntrypointReason;
  removeAfter: "2026-07-24";
  replacement: string;
};

// Reserved compatibility/helper subpaths with no current tracked imports.
// Keeping them classified avoids treating dormant compatibility as unknown debt.
export const dormantReservedBundledPluginSdkEntrypointRecords = [
  {
    subpath: "bluebubbles",
    owner: "bluebubbles",
    reason: "owner-facade-compat",
    removeAfter: "2026-07-24",
    replacement: "BlueBubbles local api/runtime-api plus generic channel SDK subpaths",
  },
  {
    subpath: "bluebubbles-policy",
    owner: "bluebubbles",
    reason: "owner-facade-compat",
    removeAfter: "2026-07-24",
    replacement: "BlueBubbles local api/runtime-api plus plugin-sdk/channel-policy",
  },
  {
    subpath: "browser-cdp",
    owner: "browser",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "plugin-sdk/browser-config plus browser local config helpers",
  },
  {
    subpath: "browser-control-auth",
    owner: "browser",
    reason: "owner-facade-compat",
    removeAfter: "2026-07-24",
    replacement: "plugin-sdk/browser-config plus browser local control-auth helpers",
  },
  {
    subpath: "browser-profiles",
    owner: "browser",
    reason: "owner-facade-compat",
    removeAfter: "2026-07-24",
    replacement: "plugin-sdk/browser-config plus browser local profile helpers",
  },
  {
    subpath: "browser-support",
    owner: "browser",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "focused browser SDK subpaths",
  },
  {
    subpath: "diagnostics-otel",
    owner: "diagnostics-otel",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "diagnostics-otel local api plus plugin-sdk/diagnostic-runtime",
  },
  {
    subpath: "diagnostics-prometheus",
    owner: "diagnostics-prometheus",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "diagnostics-prometheus local api plus plugin-sdk/diagnostic-runtime",
  },
  {
    subpath: "diffs",
    owner: "diffs",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "diffs local api/runtime-api plus generic plugin SDK subpaths",
  },
  {
    subpath: "feishu",
    owner: "feishu",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "Feishu local api/runtime-api plus generic channel SDK subpaths",
  },
  {
    subpath: "feishu-conversation",
    owner: "feishu",
    reason: "owner-facade-compat",
    removeAfter: "2026-07-24",
    replacement: "Feishu local contract-api plus plugin-sdk/conversation-runtime",
  },
  {
    subpath: "feishu-setup",
    owner: "feishu",
    reason: "owner-facade-compat",
    removeAfter: "2026-07-24",
    replacement: "Feishu local setup-api plus plugin-sdk/channel-setup",
  },
  {
    subpath: "github-copilot-login",
    owner: "github-copilot",
    reason: "owner-facade-compat",
    removeAfter: "2026-07-24",
    replacement: "GitHub Copilot local api plus plugin-sdk/provider-auth-login",
  },
  {
    subpath: "googlechat",
    owner: "googlechat",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "Google Chat local api/runtime-api plus generic channel SDK subpaths",
  },
  {
    subpath: "googlechat-runtime-shared",
    owner: "googlechat",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "Google Chat local runtime-api plus plugin-sdk/config-types",
  },
  {
    subpath: "irc",
    owner: "irc",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "IRC local api/runtime-api plus generic channel SDK subpaths",
  },
  {
    subpath: "irc-surface",
    owner: "irc",
    reason: "owner-facade-compat",
    removeAfter: "2026-07-24",
    replacement: "IRC local api plus plugin-sdk/channel-setup",
  },
  {
    subpath: "line",
    owner: "line",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "LINE local api/runtime-api plus generic channel SDK subpaths",
  },
  {
    subpath: "line-core",
    owner: "line",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "LINE local api/runtime-api plus generic channel SDK subpaths",
  },
  {
    subpath: "line-runtime",
    owner: "line",
    reason: "owner-facade-compat",
    removeAfter: "2026-07-24",
    replacement: "LINE local runtime-api plus generic channel SDK subpaths",
  },
  {
    subpath: "line-surface",
    owner: "line",
    reason: "owner-facade-compat",
    removeAfter: "2026-07-24",
    replacement: "LINE local runtime-api plus plugin-sdk/channel-setup",
  },
  {
    subpath: "llm-task",
    owner: "llm-task",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "llm-task local api plus plugin-sdk/plugin-entry",
  },
  {
    subpath: "matrix",
    owner: "matrix",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "Matrix local api/runtime-api plus generic channel SDK subpaths",
  },
  {
    subpath: "matrix-helper",
    owner: "matrix",
    reason: "owner-facade-compat",
    removeAfter: "2026-07-24",
    replacement: "Matrix local api plus plugin-sdk/config-types",
  },
  {
    subpath: "matrix-runtime-heavy",
    owner: "matrix",
    reason: "owner-facade-compat",
    removeAfter: "2026-07-24",
    replacement: "Matrix local runtime-api plus doctor/fix migration paths",
  },
  {
    subpath: "matrix-runtime-surface",
    owner: "matrix",
    reason: "owner-facade-compat",
    removeAfter: "2026-07-24",
    replacement: "Matrix local runtime-api plus plugin-sdk/config-types",
  },
  {
    subpath: "matrix-surface",
    owner: "matrix",
    reason: "owner-facade-compat",
    removeAfter: "2026-07-24",
    replacement: "Matrix local contract/runtime API plus generic channel SDK subpaths",
  },
  {
    subpath: "matrix-thread-bindings",
    owner: "matrix",
    reason: "owner-facade-compat",
    removeAfter: "2026-07-24",
    replacement: "Matrix local api plus plugin-sdk/thread-bindings-runtime",
  },
  {
    subpath: "mattermost",
    owner: "mattermost",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "Mattermost local api/runtime-api plus generic channel SDK subpaths",
  },
  {
    subpath: "mattermost-policy",
    owner: "mattermost",
    reason: "owner-facade-compat",
    removeAfter: "2026-07-24",
    replacement: "Mattermost local policy-api plus plugin-sdk/channel-policy",
  },
  {
    subpath: "memory-lancedb",
    owner: "memory-lancedb",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "memory-lancedb local api plus plugin-sdk/plugin-entry",
  },
  {
    subpath: "msteams",
    owner: "msteams",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "Microsoft Teams local api/runtime-api plus generic channel SDK subpaths",
  },
  {
    subpath: "nextcloud-talk",
    owner: "nextcloud-talk",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "Nextcloud Talk local api/runtime-api plus generic channel SDK subpaths",
  },
  {
    subpath: "nostr",
    owner: "nostr",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "Nostr local api/runtime-api plus generic channel SDK subpaths",
  },
  {
    subpath: "opencode",
    owner: "opencode",
    reason: "external-compat",
    removeAfter: "2026-07-24",
    replacement: "plugin-sdk/provider-auth-api-key plus OpenCode local provider helpers",
  },
  {
    subpath: "telegram-command-ui",
    owner: "telegram",
    reason: "external-compat",
    removeAfter: "2026-07-24",
    replacement: "plugin-sdk/telegram-command-config plus Telegram local command UI helpers",
  },
  {
    subpath: "thread-ownership",
    owner: "thread-ownership",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "thread-ownership local api plus plugin-sdk/plugin-entry",
  },
  {
    subpath: "tlon",
    owner: "tlon",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "Tlon local api/runtime-api plus generic channel SDK subpaths",
  },
  {
    subpath: "twitch",
    owner: "twitch",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "Twitch local api/runtime-api plus generic channel SDK subpaths",
  },
  {
    subpath: "voice-call",
    owner: "voice-call",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "Voice Call local api plus plugin-sdk/plugin-entry",
  },
  {
    subpath: "zalo",
    owner: "zalo",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "Zalo local api/runtime-api plus generic channel SDK subpaths",
  },
  {
    subpath: "zalo-setup",
    owner: "zalo",
    reason: "owner-facade-compat",
    removeAfter: "2026-07-24",
    replacement: "Zalo local setup/contract APIs plus plugin-sdk/channel-setup",
  },
  {
    subpath: "zalouser",
    owner: "zalouser",
    reason: "bundled-plugin-compat",
    removeAfter: "2026-07-24",
    replacement: "Zalo user local api/runtime-api plus generic channel SDK subpaths",
  },
] as const satisfies readonly DormantReservedBundledPluginSdkEntrypointRecord[];

export const dormantReservedBundledPluginSdkEntrypoints =
  dormantReservedBundledPluginSdkEntrypointRecords.map((record) => record.subpath);

// Supported SDK facades backed by bundled plugins. These are intentionally public
// until they move to generic, plugin-neutral contracts.
export const supportedBundledFacadeSdkEntrypoints = [
  "lmstudio",
  "lmstudio-runtime",
  "memory-core-engine-runtime",
  "qa-runner-runtime",
  "tts-runtime",
] as const;

// Plugin-owned surfaces that are intentionally public and documented for third-party plugins.
export const publicPluginOwnedSdkEntrypoints = [
  "browser-config",
  "image-generation-core",
  "memory-core-host-engine-embeddings",
  "memory-core-host-engine-foundation",
  "memory-core-host-engine-qmd",
  "memory-core-host-engine-storage",
  "memory-core-host-events",
  "memory-core-host-multimodal",
  "memory-core-host-query",
  "memory-core-host-runtime-cli",
  "memory-core-host-runtime-core",
  "memory-core-host-runtime-files",
  "memory-core-host-secret",
  "memory-core-host-status",
  "memory-host-core",
  "memory-host-events",
  "memory-host-files",
  "memory-host-markdown",
  "memory-host-search",
  "memory-host-status",
  "speech-core",
  "telegram-command-config",
  "video-generation-core",
] as const;

/** Map every SDK entrypoint name to its source file path inside the repo. */
export function buildPluginSdkEntrySources(entries: readonly string[] = pluginSdkEntrypoints) {
  return Object.fromEntries(entries.map((entry) => [entry, `src/plugin-sdk/${entry}.ts`]));
}

/** List the public package specifiers that should resolve to plugin SDK entrypoints. */
export function buildPluginSdkSpecifiers() {
  return pluginSdkEntrypoints.map((entry) =>
    entry === "index" ? "openclaw/plugin-sdk" : `openclaw/plugin-sdk/${entry}`,
  );
}

/** Build the package.json exports map for all plugin SDK subpaths. */
export function buildPluginSdkPackageExports() {
  return Object.fromEntries(
    pluginSdkEntrypoints.map((entry) => [
      entry === "index" ? "./plugin-sdk" : `./plugin-sdk/${entry}`,
      {
        types: `./dist/plugin-sdk/${entry}.d.ts`,
        default: `./dist/plugin-sdk/${entry}.js`,
      },
    ]),
  );
}

/** List the dist artifacts expected for every generated plugin SDK entrypoint. */
export function listPluginSdkDistArtifacts() {
  return pluginSdkEntrypoints.flatMap((entry) => [
    `dist/plugin-sdk/${entry}.js`,
    `dist/plugin-sdk/${entry}.d.ts`,
  ]);
}
