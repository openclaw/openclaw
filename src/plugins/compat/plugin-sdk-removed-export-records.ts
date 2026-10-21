import type { PluginCompatRecord } from "./types.js";

const CHANNEL_CLEANUP_REMOVAL = {
  removeAfter: "2026-10-04",
} as const;

const REMOVED_EXPORT_SEEDS = [
  {
    code: "plugin-sdk-allowlist-resolution-entry-mapper",
    ...CHANNEL_CLEANUP_REMOVAL,
    owner: "channel",
    subpath: "allow-from",
    names: ["mapBasicAllowlistResolutionEntries"],
    replacement: "None; project BasicAllowlistResolutionEntry fields in the consuming plugin.",
  },
  {
    code: "plugin-sdk-computer-use-validator-compiler",
    ...CHANNEL_CLEANUP_REMOVAL,
    owner: "sdk",
    subpath: "computer-use",
    names: ["compileComputerUseValidator"],
    replacement:
      "Use Compile(schema).Check from `typebox/compile` with the schemas exported by `openclaw/plugin-sdk/computer-use`.",
  },
  {
    code: "plugin-sdk-stoppable-passive-monitor",
    ...CHANNEL_CLEANUP_REMOVAL,
    owner: "channel",
    subpath: "extension-shared",
    names: ["runStoppablePassiveMonitor"],
    replacement:
      "Use `openclaw/plugin-sdk/channel-outbound.runPassiveAccountLifecycle` with stop: (monitor) => monitor.stop().",
  },
  {
    code: "plugin-sdk-advertised-lan-host",
    ...CHANNEL_CLEANUP_REMOVAL,
    owner: "sdk",
    subpath: "gateway-runtime",
    names: ["resolveAdvertisedLanHost"],
    replacement:
      "None; advertised LAN host discovery is host-owned and has no public SDK replacement.",
  },
  {
    code: "plugin-sdk-json-file-fallback-reader",
    ...CHANNEL_CLEANUP_REMOVAL,
    owner: "sdk",
    subpath: "json-store",
    names: ["readJsonFileWithFallback"],
    replacement:
      "None; plugins that read JSON artifacts must own parsing, fallback, and file-existence handling.",
  },
  {
    code: "plugin-sdk-secret-input-mode-normalizer",
    ...CHANNEL_CLEANUP_REMOVAL,
    owner: "provider",
    subpath: "provider-auth",
    names: ["normalizeSecretInputModeInput"],
    replacement:
      "None; validate plugin-owned input as the exported SecretInputMode values plaintext or ref.",
  },
  {
    code: "plugin-sdk-persistent-dedupe-legacy-json-migration",
    removeAfter: "2026-10-04",
    owner: "sdk",
    subpath: "persistent-dedupe",
    names: [
      "PersistentDedupeLegacyJsonMigrationOptions",
      "PersistentDedupeLegacyJsonMigrationResult",
      "listPersistentDedupeLegacyJsonFileEntries",
      "migratePersistentDedupeLegacyJsonFile",
    ],
    replacement:
      "None; the legacy JSON migration was retired. Runtime dedupe continues through the SQLite-backed persistent-dedupe APIs.",
  },
  {
    code: "plugin-sdk-provider-auth-copilot-helpers",
    removeAfter: "2026-10-01",
    owner: "provider",
    subpath: "provider-auth",
    names: [
      "CachedCopilotToken",
      "DEFAULT_COPILOT_API_BASE_URL",
      "deriveCopilotApiBaseUrlFromToken",
      "resolveCopilotApiToken",
    ],
    replacement:
      "Provider-local auth APIs for GitHub Copilot; none in the public SDK. Third-party plugins must own their provider-specific token exchange and caching.",
  },
] as const;

function buildRemovedExportRecord(seed: (typeof REMOVED_EXPORT_SEEDS)[number]) {
  return {
    code: seed.code,
    status: "removed",
    owner: seed.owner,
    removeAfter: seed.removeAfter,
    replacement: seed.replacement,
    docsPath: "/plugins/sdk-migration/removed-surfaces#retroactively-recorded-shipped-exports",
    surfaces: seed.names.map((name) => `openclaw/plugin-sdk/${seed.subpath}.${name}`),
    diagnostics: ["plugin SDK shipped-surface guard and migration guide"],
  } satisfies PluginCompatRecord;
}

export const PLUGIN_SDK_REMOVED_EXPORT_RECORDS = [
  ...REMOVED_EXPORT_SEEDS.map(buildRemovedExportRecord),
  {
    code: "plugin-sdk-reply-silence-parsers",
    status: "removed",
    owner: "agent-runtime",
    removeAfter: "2026-10-12",
    replacement:
      "Delivery plugins forward prepared text without parsing it. Harness producers use prepareAgentRunTerminalReply from openclaw/plugin-sdk/agent-harness-runtime once and publish its terminalReply. Import SILENT_REPLY_TOKEN from openclaw/plugin-sdk/reply-runtime instead of reply-chunking.",
    docsPath: "/plugins/sdk-migration/removed-surfaces#reply-silence-parsing",
    surfaces: [
      "openclaw/plugin-sdk/reply-chunking.isSilentReplyText",
      "openclaw/plugin-sdk/reply-chunking.isSilentReplyPayloadText",
      "openclaw/plugin-sdk/reply-chunking.SILENT_REPLY_TOKEN",
    ],
    diagnostics: ["plugin SDK shipped-surface guard and migration guide"],
  },
] as const satisfies readonly PluginCompatRecord[];
