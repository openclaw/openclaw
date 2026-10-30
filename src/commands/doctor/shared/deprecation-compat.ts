type DoctorDeprecationCompatStatus = "active" | "deprecated" | "removal-pending" | "removed";

type DoctorDeprecationCompatOwner =
  | "agent-runtime"
  | "audio"
  | "browser"
  | "channel"
  | "config"
  | "gateway"
  | "plugin"
  | "provider"
  | "tools"
  | "tts";

export type DoctorDeprecationCompatRecord = {
  /** Stable inventory code for a doctor compatibility surface. */
  code: string;
  /** Current lifecycle state for the compatibility surface. */
  status: DoctorDeprecationCompatStatus;
  /** Area that owns the deprecated input or migration. */
  owner: DoctorDeprecationCompatOwner;
  /** Date or release window when the compatibility surface first shipped. */
  introduced: string;
  deprecated?: string;
  warningStarts?: string;
  removeAfter?: string;
  previousRemoveAfter?: string;
  renewedAt?: string;
  source: string;
  migration: string;
  replacement: string;
  docsPath: string;
  notes?: string;
};

const DOCTOR_COMPAT_RENEWED_AT = "2026-08-29";
const DOCTOR_COMPAT_RENEWED_REMOVE_AFTER = "2026-11-29";

type CompatRecordInput = Omit<
  DoctorDeprecationCompatRecord,
  "code" | "status" | "removeAfter" | "renewedAt"
>;

function compatRecord(
  code: string,
  status: DoctorDeprecationCompatStatus,
  record: CompatRecordInput,
): DoctorDeprecationCompatRecord {
  return {
    code,
    status,
    deprecated: record.introduced,
    warningStarts: record.introduced,
    previousRemoveAfter: "2026-07-26",
    ...record,
    renewedAt: DOCTOR_COMPAT_RENEWED_AT,
    removeAfter: DOCTOR_COMPAT_RENEWED_REMOVE_AFTER,
  };
}

function julyDeprecatedCompatRecord(
  code: string,
  record: Omit<CompatRecordInput, "previousRemoveAfter">,
): DoctorDeprecationCompatRecord {
  return compatRecord(code, "deprecated", {
    previousRemoveAfter: "2026-09-18",
    ...record,
  });
}

// Doctor migrations and repair shims can outlive the runtime/config compatibility
// path they repair. Release removals must check this inventory before deleting
// doctor fixes, and replacement notes should be revalidated against the current
// architecture because ownership and config footprint can shift during rollout.
const DOCTOR_DEPRECATION_COMPAT_RECORDS = [
  // Restored after the August renewal; this is a new, unrenewed removal window.
  {
    code: "doctor-pre-july-retired-state",
    status: "deprecated",
    owner: "config",
    introduced: "2026-10-16",
    deprecated: "2026-10-16",
    warningStarts: "2026-10-16",
    removeAfter: "2026-11-29",
    source:
      "pre-July JSON runtime state, OAuth sidecars, cron jobs, queues, and sandbox registries",
    migration: "src/commands/doctor-retired-state-repair.ts",
    replacement: "canonical SQLite state and byte-preserving archives for obsolete sources",
    docsPath: "/cli/doctor/state-migrations",
    notes:
      "Temporary fix for the #174343 upgrade dead end, restored by #174489; removal requested by Peter.",
  },
  compatRecord("doctor-context-budget-one-knob", "deprecated", {
    previousRemoveAfter: "2026-11-16",
    owner: "config",
    introduced: "2026-08-16",
    source:
      "models.providers.* context defaults and agents.defaults/entries/list contextTokens caps",
    migration: "src/commands/doctor/shared/legacy-context-budget.ts",
    replacement:
      "models.providers.<provider>.models[].contextTokens active-input caps and per-model contextWindow metadata",
    docsPath: "/concepts/model-providers",
  }),
  compatRecord("doctor-cli-backends-plugin-registration", "deprecated", {
    previousRemoveAfter: "2026-09-22",
    owner: "agent-runtime",
    introduced: "2026-07-21",
    source: "agents.defaults.cliBackends adapter DSL",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.cli-backends.ts",
    replacement: "registerCliBackend plugin registrations and model-scoped agentRuntime.id",
    docsPath: "/plugins/cli-backend-plugins",
  }),
  compatRecord("doctor-model-compat-catalog-ownership", "deprecated", {
    previousRemoveAfter: "2026-09-22",
    owner: "provider",
    introduced: "2026-07-21",
    source: "model compat capability ownership moved from known-model config to provider catalogs",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.models.ts",
    replacement: "provider catalog compat metadata, with config compat reserved for custom routes",
    docsPath: "/gateway/config-tools",
  }),
  julyDeprecatedCompatRecord("doctor-tier-eval-tranche", {
    owner: "config",
    introduced: "2026-07-20",
    source: "approved tier-eval tranche 6a and small hookify retirements",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.retired.ts",
    replacement:
      "canonical config owners, shared SQLite state, built-in defaults, and plugin hooks",
    docsPath: "/gateway/doctor",
  }),
  julyDeprecatedCompatRecord("doctor-final-layout-polish", {
    owner: "config",
    introduced: "2026-07-19",
    source: "final layout renames, removed knobs, and agents.list",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.retired.ts",
    replacement: "canonical final layout and built-in defaults",
    docsPath: "/gateway/doctor",
  }),
  julyDeprecatedCompatRecord("doctor-phase4-product-config-retirements", {
    owner: "config",
    introduced: "2026-07-19",
    source: "systemAgent; crestodian; marketplaces; cli.banner.taglineMode; commitments",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.retired.ts",
    replacement: "built-in rescue, marketplace, banner, and retired commitments behavior",
    docsPath: "/gateway/doctor",
  }),
  julyDeprecatedCompatRecord("doctor-media-models-consolidation", {
    owner: "tools",
    introduced: "2026-07-19",
    source: "tools.media.image/audio/video models",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.retired.ts",
    replacement: "capability-tagged tools.media.models plus per-capability policy and defaults",
    docsPath: "/nodes/media-understanding",
  }),
  julyDeprecatedCompatRecord("doctor-runtime-tuning-knobs-purge", {
    owner: "config",
    introduced: "2026-07-19",
    source: "retired runtime and bundled-channel numeric tuning knobs",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.retired.ts",
    replacement: "built-in runtime and channel defaults",
    docsPath: "/gateway/doctor",
  }),
  julyDeprecatedCompatRecord("doctor-phase2-channel-dm-aliases", {
    owner: "channel",
    introduced: "2026-07-18",
    source: "Discord, Slack, and Google Chat dm.policy and dm.allowFrom",
    migration: "src/config/channel-alias-migration.ts",
    replacement: "dmPolicy and allowFrom at the same channel or account level",
    docsPath: "/cli/doctor",
  }),
  julyDeprecatedCompatRecord("doctor-phase1-retired-runtime-config", {
    owner: "config",
    introduced: "2026-07-18",
    source:
      "tui; commands.modelsWrite; messages.messagePrefix; tools media/message aliases; realtime voice aliases",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.retired.ts",
    replacement:
      "canonical channel, media providerOptions, crossContext, and speakerVoice settings",
    docsPath: "/cli/doctor",
  }),
  julyDeprecatedCompatRecord("doctor-root-default-model", {
    owner: "config",
    introduced: "2026-07-18",
    source: "defaultModel",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.models.ts",
    replacement: "agents.defaults.model",
    docsPath: "/gateway/doctor",
  }),
  julyDeprecatedCompatRecord("doctor-session-prune-reset-aliases", {
    owner: "config",
    introduced: "2026-07-18",
    source: "session.maintenance.pruneDays; session.resetByType.dm",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.session.ts",
    replacement: "session.maintenance.pruneAfter; session.resetByType.direct",
    docsPath: "/gateway/configuration-reference",
  }),
  julyDeprecatedCompatRecord("doctor-mcp-timeout-aliases", {
    owner: "config",
    introduced: "2026-07-18",
    source: "mcp.servers.*.connectTimeout; connect_timeout; timeout",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.mcp.ts",
    replacement: "connectionTimeoutMs; requestTimeoutMs",
    docsPath: "/cli/mcp",
  }),
  julyDeprecatedCompatRecord("doctor-cron-webhook-fallback", {
    owner: "config",
    introduced: "2026-07-18",
    source: "cron.webhook",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.cron.ts",
    replacement: "per-job delivery.to or delivery.completionDestination",
    docsPath: "/automation/cron-jobs",
  }),
  julyDeprecatedCompatRecord("doctor-canvas-host-root", {
    owner: "plugin",
    introduced: "2026-07-18",
    source: "canvasHost",
    migration: "extensions/canvas/setup-api.ts",
    replacement: "plugins.entries.canvas.config.host",
    docsPath: "/plugins",
  }),
  julyDeprecatedCompatRecord("doctor-phase1-channel-noops-aliases", {
    owner: "channel",
    introduced: "2026-07-18",
    source:
      "Telegram topics; Slack DM reply mode; WhatsApp exposeErrorText; Google Chat reactions; thread binding spawn aliases",
    migration: "src/commands/doctor/shared/legacy-config-migrations.channels.ts",
    replacement: "canonical channel settings or removal",
    docsPath: "/channels/channel-routing",
  }),
  compatRecord("doctor-agent-llm-timeout", "removed", {
    owner: "agent-runtime",
    introduced: "2026-04-27",
    source: "agents.defaults.llm.idleTimeoutSeconds",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "models.providers.<id>.timeoutSeconds",
    docsPath: "/gateway/config-agents",
    notes:
      "Pre-June configs must pass through OpenClaw 2026.9.5 Doctor before upgrading; current Doctor no longer migrates this key.",
  }),
  julyDeprecatedCompatRecord("doctor-memory-search-owner-consolidation", {
    owner: "config",
    introduced: "2026-07-19",
    source: "memorySearch; agents.defaults.memorySearch; agents.list[].memorySearch",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "memory.search; agents.list[].memory.search",
    docsPath: "/reference/memory-config",
  }),
  julyDeprecatedCompatRecord("doctor-session-typing-mode-owner", {
    owner: "agent-runtime",
    introduced: "2026-07-19",
    source: "session.typingMode",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "agents.defaults.typingMode or agents.list[].typingMode",
    docsPath: "/concepts/typing-indicators",
  }),
  compatRecord("doctor-top-level-heartbeat", "removed", {
    owner: "config",
    introduced: "2026-04-26",
    source: "heartbeat",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "agents.defaults.heartbeat and channels.defaults.heartbeat",
    docsPath: "/automation",
    notes:
      "Pre-June configs must pass through OpenClaw 2026.9.5 Doctor before upgrading; current Doctor no longer migrates this key.",
  }),
  compatRecord("doctor-mcp-server-type-alias", "removal-pending", {
    owner: "config",
    introduced: "2026-04-27",
    source: "mcp.servers.*.type",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.mcp.ts",
    replacement: "mcp.servers.*.transport",
    docsPath: "/cli/mcp",
    notes:
      "OpenClaw stores transport names; CLI backends receive their own type fields through runtime adapters.",
  }),
  compatRecord("doctor-gateway-bind-host-aliases", "removal-pending", {
    owner: "gateway",
    introduced: "2026-04-26",
    source: "gateway.bind host aliases such as 0.0.0.0 and localhost",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.gateway.ts",
    replacement: "gateway.bind.mode values such as lan, loopback, custom, tailnet, and auto",
    docsPath: "/gateway/configuration",
  }),
  compatRecord("doctor-audio-transcription-command", "removal-pending", {
    owner: "audio",
    introduced: "2026-04-26",
    source: "audio.transcription",
    migration: "src/commands/doctor/shared/legacy-config-migrations.audio.ts",
    replacement: "capability-tagged tools.media.models",
    docsPath: "/tools/media-overview",
  }),
  compatRecord("doctor-channel-thread-binding-ttl", "removal-pending", {
    owner: "channel",
    introduced: "2026-04-26",
    source: "threadBindings.ttlHours",
    migration: "src/commands/doctor/shared/legacy-config-migrations.channels.ts",
    replacement: "threadBindings.idleHours",
    docsPath: "/channels/channel-routing",
  }),
  compatRecord("doctor-channel-dm-aliases", "removal-pending", {
    owner: "channel",
    introduced: "2026-04-26",
    source: "channels.<id>.dm.policy and channels.<id>.dm.allowFrom",
    migration: "src/config/channel-compat-normalization.ts",
    replacement: "channels.<id>.dmPolicy and channels.<id>.allowFrom",
    docsPath: "/channels/channel-routing",
  }),
  compatRecord("doctor-channel-streaming-aliases", "removal-pending", {
    owner: "channel",
    introduced: "2026-04-26",
    source: "streamMode, scalar streaming, chunkMode, blockStreaming, draftChunk, nativeStreaming",
    migration: "src/config/channel-compat-normalization.ts",
    replacement: "channels.<id>.streaming.*",
    docsPath: "/channels/channel-routing",
    notes:
      "Runtime reads are nested-only; doctor keeps this migration to move shipped configs during upgrade.",
  }),
  compatRecord("doctor-webchat-channel-config", "removed", {
    owner: "channel",
    introduced: "2026-05-18",
    deprecated: "2026-05-31",
    warningStarts: "2026-05-31",
    previousRemoveAfter: "2026-08-31",
    source: "channels.webchat",
    migration: "src/commands/doctor/shared/legacy-config-migrations.channels.ts",
    replacement: "chat.history maxChars per-request override when a custom client needs it",
    docsPath: "/web/webchat",
    notes:
      "WebChat is an internal control surface, not a configurable outbound channel. Doctor refuses this retired key with an intermediate-upgrade path.",
  }),
  julyDeprecatedCompatRecord("doctor-tts-top-level-owner", {
    owner: "tts",
    introduced: "2026-07-19",
    source: "messages.tts",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.tts.ts",
    replacement: "top-level tts",
    docsPath: "/tools/tts",
  }),
  compatRecord("doctor-tts-provider-aliases", "removal-pending", {
    owner: "tts",
    introduced: "2026-04-26",
    source: "messages.tts.openai/elevenlabs/edge and plugins.entries.voice-call.config.tts aliases",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.tts.ts",
    replacement: "tts.providers.<provider> and microsoft instead of edge",
    docsPath: "/tools/tts",
  }),
  compatRecord("doctor-tts-enabled-auto-mode", "removal-pending", {
    owner: "tts",
    introduced: "2026-04-29",
    source:
      "messages.tts.enabled, agents.list[].tts.enabled, supported channel TTS enabled fields, and voice-call plugin tts.enabled",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.tts.ts",
    replacement:
      'supported top-level/agents/channels/plugins TTS auto mode, for example auto: "always" or auto: "off"',
    docsPath: "/tools/tts",
  }),
  compatRecord("doctor-tts-speaker-selection-fields", "removal-pending", {
    owner: "tts",
    introduced: "2026-05-28",
    source: "TTS provider speaker selection fields named voice, voiceName, and voiceId",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.tts.ts",
    replacement: "speakerVoice and speakerVoiceId",
    docsPath: "/tools/tts",
  }),
  compatRecord("doctor-bundled-plugin-load-paths", "removal-pending", {
    owner: "plugin",
    introduced: "2026-04-25",
    deprecated: "2026-04-26",
    warningStarts: "2026-04-26",
    source: "plugins.load.paths entries that point at bundled plugin source/dist locations",
    migration: "src/commands/doctor/shared/bundled-plugin-load-paths.ts",
    replacement: "packaged bundled plugins and the persisted plugin registry",
    docsPath: "/cli/plugins#registry",
  }),
  compatRecord("doctor-bundled-provider-discovery-allowlist", "removal-pending", {
    owner: "plugin",
    introduced: "2026-04-25",
    deprecated: "2026-04-26",
    warningStarts: "2026-04-26",
    source: "plugins.allow configs created before bundled provider discovery was explicit",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.providers.ts",
    replacement: "plugins.bundledDiscovery allowlist mode plus explicit plugin/provider entries",
    docsPath: "/cli/plugins#registry",
    notes:
      "Doctor preserves the shipped upgrade path only; runtime compatibility should stay behind explicit bundledDiscovery config.",
  }),
  compatRecord("doctor-codex-supervisor-plugin-config", "deprecated", {
    owner: "plugin",
    introduced: "2026-05-29",
    deprecated: "2026-07-09",
    warningStarts: "2026-07-09",
    previousRemoveAfter: "2026-10-09",
    source: "plugins.entries.codex-supervisor and codex-supervisor plugin policy references",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.providers.ts",
    replacement: "plugins.entries.codex.config.supervision",
    docsPath: "/plugins/codex-supervision",
    notes:
      "The core bootstrap migration must remain available when the external Codex plugin is not installed yet.",
  }),
  compatRecord("doctor-web-search-plugin-config", "removal-pending", {
    owner: "provider",
    introduced: "2026-04-26",
    source: "tools.web.search.apiKey and tools.web.search.<provider>",
    migration: "src/commands/doctor/shared/legacy-web-tools-migrate.ts",
    replacement: "plugins.entries.<plugin>.config.webSearch",
    docsPath: "/tools/web",
    notes:
      "Provider/plugin ownership can move as bundled providers externalize; verify the current manifest owner before deleting migration support.",
  }),
  compatRecord("doctor-web-fetch-plugin-config", "removal-pending", {
    owner: "provider",
    introduced: "2026-04-26",
    source: "tools.web.fetch.firecrawl",
    migration: "src/commands/doctor/shared/legacy-web-tools-migrate.ts",
    replacement: "plugins.entries.firecrawl.config.webFetch",
    docsPath: "/tools/web-fetch",
  }),
  compatRecord("doctor-x-search-plugin-config", "removal-pending", {
    owner: "provider",
    introduced: "2026-04-26",
    source: "tools.web.x_search.apiKey",
    migration: "src/commands/doctor/shared/legacy-web-tools-migrate.ts",
    replacement: "plugins.entries.xai.config.webSearch.apiKey",
    docsPath: "/tools/grok-search",
  }),
  compatRecord("doctor-talk-provider-shape", "removal-pending", {
    owner: "tts",
    introduced: "2026-04-26",
    source: "legacy talk provider scalar fields and provider/provider ids",
    migration: "src/commands/doctor/shared/legacy-talk-config-normalizer.ts",
    replacement: "talk.providers.<provider>",
    docsPath: "/tools/tts",
  }),
  compatRecord("doctor-legacy-tools-by-sender", "removal-pending", {
    owner: "tools",
    introduced: "2026-04-26",
    source: "untyped toolsBySender keys",
    migration: "src/commands/doctor/shared/legacy-tools-by-sender.ts",
    replacement: "typed id:, e164:, username:, or name: sender keys",
    docsPath: "/tools/exec-approvals",
  }),
] as const satisfies readonly DoctorDeprecationCompatRecord[];

/** List every doctor compatibility record, including removed or still-active entries. */
export function listDoctorDeprecationCompatRecords(): readonly DoctorDeprecationCompatRecord[] {
  return DOCTOR_DEPRECATION_COMPAT_RECORDS;
}
