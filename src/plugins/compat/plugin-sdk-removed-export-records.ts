import type { PluginCompatRecord } from "./types.js";

const CHANNEL_CLEANUP_REMOVAL = {
  commit: "2fec39f57319be5b6e0b20b5305665ed1ff5e685",
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
    commit: "bd64d93ff1ae704d13813f6580c4809ba0e76606",
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
    commit: "f2de06b38de710854aacd19218327358445816c8",
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
    introduced: "2026-10-07",
    removeAfter: seed.removeAfter,
    replacement: seed.replacement,
    docsPath: "/plugins/sdk-migration/removed-surfaces#retroactively-recorded-shipped-exports",
    surfaces: seed.names.map((name) => `openclaw/plugin-sdk/${seed.subpath}.${name}`),
    diagnostics: ["plugin SDK shipped-surface guard and migration guide"],
    tests: [
      "src/plugins/compat/registry.test.ts",
      "test/scripts/plugin-sdk-shipped-surface.test.ts",
    ],
    releaseNote: `The ${seed.names.join(", ")} exports from openclaw/plugin-sdk/${seed.subpath} were removed without a compatibility window in ${seed.commit}. This removal was recorded retroactively on 2026-10-07 when the shipped-surface guard was introduced.`,
  } satisfies PluginCompatRecord;
}

export const PLUGIN_SDK_REMOVED_EXPORT_RECORDS = [
  ...REMOVED_EXPORT_SEEDS.map(buildRemovedExportRecord),
  {
    code: "plugin-sdk-heartbeat-reply-runtime",
    status: "removed",
    owner: "agent-runtime",
    introduced: "2026-10-08",
    removeAfter: "2026-10-03",
    replacement:
      "Use ordinary Automations and SILENT_REPLY_TOKEN/isSilentReplyText from openclaw/plugin-sdk/reply-runtime; heartbeat-specific prompt and reply normalization no longer applies.",
    docsPath: "/plugins/sdk-migration/removed-surfaces#heartbeat-runtime-and-reply-helpers",
    surfaces: [
      "openclaw/plugin-sdk/reply-runtime.HEARTBEAT_PROMPT",
      "openclaw/plugin-sdk/reply-runtime.DEFAULT_HEARTBEAT_ACK_MAX_CHARS",
      "openclaw/plugin-sdk/reply-runtime.resolveHeartbeatPromptCore",
      "openclaw/plugin-sdk/reply-runtime.stripHeartbeatToken",
      "openclaw/plugin-sdk/reply-runtime.resolveHeartbeatReplyPayload",
      "openclaw/plugin-sdk/reply-runtime.HEARTBEAT_TOKEN",
    ],
    diagnostics: ["plugin SDK shipped-surface guard and migration guide"],
    tests: [
      "src/plugins/compat/registry.test.ts",
      "test/scripts/plugin-sdk-shipped-surface.test.ts",
    ],
    releaseNote:
      "Maintainer-approved breaking removal on 2026-10-03: heartbeat execution moved to ordinary Automations; these exports are removed without deprecated aliases.",
  },
  {
    code: "plugin-sdk-heartbeat-agent-harness-runtime",
    status: "removed",
    owner: "agent-runtime",
    introduced: "2026-10-08",
    removeAfter: "2026-10-03",
    replacement:
      "Use ordinary reply text and the standard silent reply convention; the heartbeat response tool and structured response no longer exist.",
    docsPath: "/plugins/sdk-migration/removed-surfaces#heartbeat-runtime-and-reply-helpers",
    surfaces: [
      "openclaw/plugin-sdk/agent-harness-runtime.HeartbeatToolResponse",
      "openclaw/plugin-sdk/agent-harness-runtime.HEARTBEAT_RESPONSE_TOOL_NAME",
      "openclaw/plugin-sdk/agent-harness-runtime.normalizeHeartbeatToolResponse",
    ],
    diagnostics: ["plugin SDK shipped-surface guard and migration guide"],
    tests: [
      "src/plugins/compat/registry.test.ts",
      "test/scripts/plugin-sdk-shipped-surface.test.ts",
    ],
    releaseNote:
      "Maintainer-approved breaking removal on 2026-10-03: agent harnesses no longer register or normalize heartbeat response tools; no deprecated aliases remain.",
  },
] as const satisfies readonly PluginCompatRecord[];
