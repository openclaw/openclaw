import { VERSION } from "../version.js";
import { ClawdbotSchema } from "./zod-schema.js";

export type ConfigUiHint = {
  label?: string;
  help?: string;
  group?: string;
  order?: number;
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
  itemTemplate?: unknown;
};

export type ConfigUiHints = Record<string, ConfigUiHint>;

export type ConfigSchema = ReturnType<typeof ClawdbotSchema.toJSONSchema>;

export type ConfigSchemaResponse = {
  schema: ConfigSchema;
  uiHints: ConfigUiHints;
  version: string;
  generatedAt: string;
};

export type PluginUiMetadata = {
  id: string;
  name?: string;
  description?: string;
  configUiHints?: Record<
    string,
    Pick<
      ConfigUiHint,
      "label" | "help" | "advanced" | "sensitive" | "placeholder"
    >
  >;
};

const GROUP_LABELS: Record<string, string> = {
  wizard: "Wizard",
  logging: "Logging",
  gateway: "Gateway",
  agents: "Agents",
  tools: "Tools",
  bindings: "Bindings",
  audio: "Audio",
  models: "Models",
  messages: "Messages",
  commands: "Commands",
  session: "Session",
  cron: "Cron",
  hooks: "Hooks",
  ui: "UI",
  browser: "Browser",
  talk: "Talk",
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  signal: "Signal",
  imessage: "iMessage",
  whatsapp: "WhatsApp",
  skills: "Skills",
  plugins: "Plugins",
  discovery: "Discovery",
  presence: "Presence",
  voicewake: "Voice Wake",
};

const GROUP_ORDER: Record<string, number> = {
  wizard: 20,
  gateway: 30,
  agents: 40,
  tools: 50,
  bindings: 55,
  audio: 60,
  models: 70,
  messages: 80,
  commands: 85,
  session: 90,
  cron: 100,
  hooks: 110,
  ui: 120,
  browser: 130,
  talk: 140,
  telegram: 150,
  discord: 160,
  slack: 165,
  signal: 170,
  imessage: 180,
  whatsapp: 190,
  skills: 200,
  plugins: 205,
  discovery: 210,
  presence: 220,
  voicewake: 230,
  logging: 900,
};

const FIELD_LABELS: Record<string, string> = {
  "gateway.remote.url": "Remote Gateway URL",
  "gateway.remote.sshTarget": "Remote Gateway SSH Target",
  "gateway.remote.sshIdentity": "Remote Gateway SSH Identity",
  "gateway.remote.token": "Remote Gateway Token",
  "gateway.remote.password": "Remote Gateway Password",
  "gateway.auth.token": "Gateway Token",
  "gateway.auth.password": "Gateway Password",
  "tools.audio.transcription.args": "Audio Transcription Args",
  "tools.audio.transcription.timeoutSeconds":
    "Audio Transcription Timeout (sec)",
  "tools.exec.applyPatch.enabled": "Enable apply_patch",
  "tools.exec.applyPatch.allowModels": "apply_patch Model Allowlist",
  "gateway.controlUi.basePath": "Control UI Base Path",
  "gateway.http.endpoints.chatCompletions.enabled":
    "OpenAI Chat Completions Endpoint",
  "gateway.reload.mode": "Config Reload Mode",
  "gateway.reload.debounceMs": "Config Reload Debounce (ms)",
  "agents.defaults.workspace": "Workspace",
  "agents.defaults.memorySearch": "Memory Search",
  "agents.defaults.memorySearch.enabled": "Enable Memory Search",
  "agents.defaults.memorySearch.provider": "Memory Search Provider",
  "agents.defaults.memorySearch.model": "Memory Search Model",
  "agents.defaults.memorySearch.fallback": "Memory Search Fallback",
  "agents.defaults.memorySearch.local.modelPath": "Local Embedding Model Path",
  "agents.defaults.memorySearch.store.path": "Memory Search Index Path",
  "agents.defaults.memorySearch.chunking.tokens": "Memory Chunk Tokens",
  "agents.defaults.memorySearch.chunking.overlap":
    "Memory Chunk Overlap Tokens",
  "agents.defaults.memorySearch.sync.onSessionStart": "Index on Session Start",
  "agents.defaults.memorySearch.sync.onSearch": "Index on Search (Lazy)",
  "agents.defaults.memorySearch.sync.watch": "Watch Memory Files",
  "agents.defaults.memorySearch.sync.watchDebounceMs":
    "Memory Watch Debounce (ms)",
  "agents.defaults.memorySearch.query.maxResults": "Memory Search Max Results",
  "agents.defaults.memorySearch.query.minScore": "Memory Search Min Score",
  "auth.profiles": "Auth Profiles",
  "auth.order": "Auth Profile Order",
  "auth.cooldowns.billingBackoffHours": "Billing Backoff (hours)",
  "auth.cooldowns.billingBackoffHoursByProvider": "Billing Backoff Overrides",
  "auth.cooldowns.billingMaxHours": "Billing Backoff Cap (hours)",
  "auth.cooldowns.failureWindowHours": "Failover Window (hours)",
  "agents.defaults.models": "Models",
  "agents.defaults.model.primary": "Primary Model",
  "agents.defaults.model.fallbacks": "Model Fallbacks",
  "agents.defaults.imageModel.primary": "Image Model",
  "agents.defaults.imageModel.fallbacks": "Image Model Fallbacks",
  "agents.defaults.humanDelay.mode": "Human Delay Mode",
  "agents.defaults.humanDelay.minMs": "Human Delay Min (ms)",
  "agents.defaults.humanDelay.maxMs": "Human Delay Max (ms)",
  "agents.defaults.cliBackends": "CLI Backends",
  "commands.native": "Native Commands",
  "commands.text": "Text Commands",
  "commands.config": "Allow /config",
  "commands.debug": "Allow /debug",
  "commands.restart": "Allow Restart",
  "commands.useAccessGroups": "Use Access Groups",
  "ui.seamColor": "Accent Color",
  "browser.controlUrl": "Browser Control URL",
  "session.agentToAgent.maxPingPongTurns": "Agent-to-Agent Ping-Pong Turns",
  "messages.ackReaction": "Ack Reaction Emoji",
  "messages.ackReactionScope": "Ack Reaction Scope",
  "talk.apiKey": "Talk API Key",
  "telegram.botToken": "Telegram Bot Token",
  "telegram.dmPolicy": "Telegram DM Policy",
  "telegram.streamMode": "Telegram Draft Stream Mode",
  "telegram.draftChunk.minChars": "Telegram Draft Chunk Min Chars",
  "telegram.draftChunk.maxChars": "Telegram Draft Chunk Max Chars",
  "telegram.draftChunk.breakPreference":
    "Telegram Draft Chunk Break Preference",
  "telegram.retry.attempts": "Telegram Retry Attempts",
  "telegram.retry.minDelayMs": "Telegram Retry Min Delay (ms)",
  "telegram.retry.maxDelayMs": "Telegram Retry Max Delay (ms)",
  "telegram.retry.jitter": "Telegram Retry Jitter",
  "whatsapp.dmPolicy": "WhatsApp DM Policy",
  "whatsapp.selfChatMode": "WhatsApp Self-Phone Mode",
  "signal.dmPolicy": "Signal DM Policy",
  "imessage.dmPolicy": "iMessage DM Policy",
  "discord.dm.policy": "Discord DM Policy",
  "discord.retry.attempts": "Discord Retry Attempts",
  "discord.retry.minDelayMs": "Discord Retry Min Delay (ms)",
  "discord.retry.maxDelayMs": "Discord Retry Max Delay (ms)",
  "discord.retry.jitter": "Discord Retry Jitter",
  "discord.maxLinesPerMessage": "Discord Max Lines Per Message",
  "slack.dm.policy": "Slack DM Policy",
  "slack.allowBots": "Slack Allow Bot Messages",
  "discord.token": "Discord Bot Token",
  "slack.botToken": "Slack Bot Token",
  "slack.appToken": "Slack App Token",
  "signal.account": "Signal Account",
  "imessage.cliPath": "iMessage CLI Path",
  "plugins.enabled": "Enable Plugins",
  "plugins.allow": "Plugin Allowlist",
  "plugins.deny": "Plugin Denylist",
  "plugins.load.paths": "Plugin Load Paths",
  "plugins.entries": "Plugin Entries",
  "plugins.entries.*.enabled": "Plugin Enabled",
  "plugins.entries.*.config": "Plugin Config",
};

const FIELD_HELP: Record<string, string> = {
  "gateway.remote.url": "Remote Gateway WebSocket URL (ws:// or wss://).",
  "gateway.remote.sshTarget":
    "Remote gateway over SSH (tunnels the gateway port to localhost). Format: user@host or user@host:port.",
  "gateway.remote.sshIdentity":
    "Optional SSH identity file path (passed to ssh -i).",
  "gateway.auth.token":
    "Recommended for all gateways; required for non-loopback binds.",
  "gateway.auth.password": "Required for Tailscale funnel.",
  "gateway.controlUi.basePath":
    "Optional URL prefix where the Control UI is served (e.g. /clawdbot).",
  "gateway.http.endpoints.chatCompletions.enabled":
    "Enable the OpenAI-compatible `POST /v1/chat/completions` endpoint (default: false).",
  "gateway.reload.mode":
    'Hot reload strategy for config changes ("hybrid" recommended).',
  "gateway.reload.debounceMs":
    "Debounce window (ms) before applying config changes.",
  "tools.exec.applyPatch.enabled":
    "Experimental. Enables apply_patch for OpenAI models when allowed by tool policy.",
  "tools.exec.applyPatch.allowModels":
    'Optional allowlist of model ids (e.g. "gpt-5.2" or "openai/gpt-5.2").',
  "slack.allowBots":
    "Allow bot-authored messages to trigger Slack replies (default: false).",
  "auth.profiles": "Named auth profiles (provider + mode + optional email).",
  "auth.order":
    "Ordered auth profile IDs per provider (used for automatic failover).",
  "auth.cooldowns.billingBackoffHours":
    "Base backoff (hours) when a profile fails due to billing/insufficient credits (default: 5).",
  "auth.cooldowns.billingBackoffHoursByProvider":
    "Optional per-provider overrides for billing backoff (hours).",
  "auth.cooldowns.billingMaxHours":
    "Cap (hours) for billing backoff (default: 24).",
  "auth.cooldowns.failureWindowHours":
    "Failure window (hours) for backoff counters (default: 24).",
  "agents.defaults.models":
    "Configured model catalog (keys are full provider/model IDs).",
  "agents.defaults.memorySearch":
    "Vector search over MEMORY.md and memory/*.md (per-agent overrides supported).",
  "agents.defaults.memorySearch.provider":
    'Embedding provider ("openai" or "local").',
  "agents.defaults.memorySearch.local.modelPath":
    "Local GGUF model path or hf: URI (node-llama-cpp).",
  "agents.defaults.memorySearch.fallback":
    'Fallback to OpenAI when local embeddings fail ("openai" or "none").',
  "agents.defaults.memorySearch.store.path":
    "SQLite index path (default: ~/.clawdbot/memory/{agentId}.sqlite).",
  "agents.defaults.memorySearch.sync.onSearch":
    "Lazy sync: reindex on first search after a change.",
  "agents.defaults.memorySearch.sync.watch":
    "Watch memory files for changes (chokidar).",
  "plugins.enabled": "Enable plugin/extension loading (default: true).",
  "plugins.allow":
    "Optional allowlist of plugin ids; when set, only listed plugins load.",
  "plugins.deny": "Optional denylist of plugin ids; deny wins over allowlist.",
  "plugins.load.paths": "Additional plugin files or directories to load.",
  "plugins.entries":
    "Per-plugin settings keyed by plugin id (enable/disable + config payloads).",
  "plugins.entries.*.enabled":
    "Overrides plugin enable/disable for this entry (restart required).",
  "plugins.entries.*.config":
    "Plugin-defined config payload (schema is provided by the plugin).",
  "agents.defaults.model.primary": "Primary model (provider/model).",
  "agents.defaults.model.fallbacks":
    "Ordered fallback models (provider/model). Used when the primary model fails.",
  "agents.defaults.imageModel.primary":
    "Optional image model (provider/model) used when the primary model lacks image input.",
  "agents.defaults.imageModel.fallbacks":
    "Ordered fallback image models (provider/model).",
  "agents.defaults.cliBackends":
    "Optional CLI backends for text-only fallback (claude-cli, etc.).",
  "agents.defaults.humanDelay.mode":
    'Delay style for block replies ("off", "natural", "custom").',
  "agents.defaults.humanDelay.minMs":
    "Minimum delay in ms for custom humanDelay (default: 800).",
  "agents.defaults.humanDelay.maxMs":
    "Maximum delay in ms for custom humanDelay (default: 2500).",
  "commands.native":
    "Register native commands with connectors that support it (Discord/Slack/Telegram).",
  "commands.text": "Allow text command parsing (slash commands only).",
  "commands.config":
    "Allow /config chat command to read/write config on disk (default: false).",
  "commands.debug":
    "Allow /debug chat command for runtime-only overrides (default: false).",
  "commands.restart":
    "Allow /restart and gateway restart tool actions (default: false).",
  "commands.useAccessGroups":
    "Enforce access-group allowlists/policies for commands.",
  "session.agentToAgent.maxPingPongTurns":
    "Max reply-back turns between requester and target (0–5).",
  "messages.ackReaction":
    "Emoji reaction used to acknowledge inbound messages (empty disables).",
  "messages.ackReactionScope":
    'When to send ack reactions ("group-mentions", "group-all", "direct", "all").',
  "telegram.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires telegram.allowFrom=["*"].',
  "telegram.streamMode":
    "Draft streaming mode for Telegram replies (off | partial | block). Separate from block streaming; requires private topics + sendMessageDraft.",
  "telegram.draftChunk.minChars":
    'Minimum chars before emitting a Telegram draft update when telegram.streamMode="block" (default: 200).',
  "telegram.draftChunk.maxChars":
    'Target max size for a Telegram draft update chunk when telegram.streamMode="block" (default: 800; clamped to telegram.textChunkLimit).',
  "telegram.draftChunk.breakPreference":
    "Preferred breakpoints for Telegram draft chunks (paragraph | newline | sentence). Default: paragraph.",
  "telegram.retry.attempts":
    "Max retry attempts for outbound Telegram API calls (default: 3).",
  "telegram.retry.minDelayMs":
    "Minimum retry delay in ms for Telegram outbound calls.",
  "telegram.retry.maxDelayMs":
    "Maximum retry delay cap in ms for Telegram outbound calls.",
  "telegram.retry.jitter":
    "Jitter factor (0-1) applied to Telegram retry delays.",
  "whatsapp.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires whatsapp.allowFrom=["*"].',
  "whatsapp.selfChatMode":
    "Same-phone setup (bot uses your personal WhatsApp number).",
  "signal.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires signal.allowFrom=["*"].',
  "imessage.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires imessage.allowFrom=["*"].',
  "discord.dm.policy":
    'Direct message access control ("pairing" recommended). "open" requires discord.dm.allowFrom=["*"].',
  "discord.retry.attempts":
    "Max retry attempts for outbound Discord API calls (default: 3).",
  "discord.retry.minDelayMs":
    "Minimum retry delay in ms for Discord outbound calls.",
  "discord.retry.maxDelayMs":
    "Maximum retry delay cap in ms for Discord outbound calls.",
  "discord.retry.jitter":
    "Jitter factor (0-1) applied to Discord retry delays.",
  "discord.maxLinesPerMessage":
    "Soft max line count per Discord message (default: 17).",
  "slack.dm.policy":
    'Direct message access control ("pairing" recommended). "open" requires slack.dm.allowFrom=["*"].',
};

const FIELD_PLACEHOLDERS: Record<string, string> = {
  "gateway.remote.url": "ws://host:18789",
  "gateway.remote.sshTarget": "user@host",
  "gateway.controlUi.basePath": "/clawdbot",
};

const SENSITIVE_PATTERNS = [/token/i, /password/i, /secret/i, /api.?key/i];

function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(path));
}

function buildBaseHints(): ConfigUiHints {
  const hints: ConfigUiHints = {};
  for (const [group, label] of Object.entries(GROUP_LABELS)) {
    hints[group] = {
      label,
      group: label,
      order: GROUP_ORDER[group],
    };
  }
  for (const [path, label] of Object.entries(FIELD_LABELS)) {
    const current = hints[path];
    hints[path] = current ? { ...current, label } : { label };
  }
  for (const [path, help] of Object.entries(FIELD_HELP)) {
    const current = hints[path];
    hints[path] = current ? { ...current, help } : { help };
  }
  for (const [path, placeholder] of Object.entries(FIELD_PLACEHOLDERS)) {
    const current = hints[path];
    hints[path] = current ? { ...current, placeholder } : { placeholder };
  }
  return hints;
}

function applySensitiveHints(hints: ConfigUiHints): ConfigUiHints {
  const next = { ...hints };
  for (const key of Object.keys(next)) {
    if (isSensitivePath(key)) {
      next[key] = { ...next[key], sensitive: true };
    }
  }
  return next;
}

function applyPluginHints(
  hints: ConfigUiHints,
  plugins: PluginUiMetadata[],
): ConfigUiHints {
  const next: ConfigUiHints = { ...hints };
  for (const plugin of plugins) {
    const id = plugin.id.trim();
    if (!id) continue;
    const name = (plugin.name ?? id).trim() || id;
    const basePath = `plugins.entries.${id}`;

    next[basePath] = {
      ...next[basePath],
      label: name,
      help: plugin.description
        ? `${plugin.description} (plugin: ${id})`
        : `Plugin entry for ${id}.`,
    };
    next[`${basePath}.enabled`] = {
      ...next[`${basePath}.enabled`],
      label: `Enable ${name}`,
    };
    next[`${basePath}.config`] = {
      ...next[`${basePath}.config`],
      label: `${name} Config`,
      help: `Plugin-defined config payload for ${id}.`,
    };

    const uiHints = plugin.configUiHints ?? {};
    for (const [relPathRaw, hint] of Object.entries(uiHints)) {
      const relPath = relPathRaw.trim().replace(/^\./, "");
      if (!relPath) continue;
      const key = `${basePath}.config.${relPath}`;
      next[key] = {
        ...next[key],
        ...hint,
      };
    }
  }
  return next;
}

let cachedBase: ConfigSchemaResponse | null = null;

function buildBaseConfigSchema(): ConfigSchemaResponse {
  if (cachedBase) return cachedBase;
  const schema = ClawdbotSchema.toJSONSchema({
    target: "draft-07",
    unrepresentable: "any",
  });
  schema.title = "ClawdbotConfig";
  const hints = applySensitiveHints(buildBaseHints());
  const next = {
    schema,
    uiHints: hints,
    version: VERSION,
    generatedAt: new Date().toISOString(),
  };
  cachedBase = next;
  return next;
}

export function buildConfigSchema(params?: {
  plugins?: PluginUiMetadata[];
}): ConfigSchemaResponse {
  const base = buildBaseConfigSchema();
  const plugins = params?.plugins ?? [];
  if (plugins.length === 0) return base;
  const merged = applySensitiveHints(applyPluginHints(base.uiHints, plugins));
  return {
    ...base,
    uiHints: merged,
  };
}
