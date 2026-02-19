import { IRC_FIELD_HELP } from "./schema.irc.js";

export const FIELD_HELP: Record<string, string> = {
  "meta.lastTouchedVersion": "Auto-set when OpenClaw writes the config.",
  "meta.lastTouchedAt": "ISO timestamp of the last config write (auto-set).",
  "update.channel": 'Update channel for git + npm installs ("stable", "beta", or "dev").',
  "update.checkOnStart": "Check for npm updates when the gateway starts (default: true).",
  "gateway.remote.url": "Remote Gateway WebSocket URL (ws:// or wss://).",
  "gateway.remote.tlsFingerprint":
    "Expected sha256 TLS fingerprint for the remote gateway (pin to avoid MITM).",
  "gateway.remote.sshTarget":
    "Remote gateway over SSH (tunnels the gateway port to localhost). Format: user@host or user@host:port.",
  "gateway.remote.sshIdentity": "Optional SSH identity file path (passed to ssh -i).",
  "agents.list.*.skills":
    "Optional allowlist of skills for this agent (omit = all skills; empty = no skills).",
  "agents.list[].skills":
    "Optional allowlist of skills for this agent (omit = all skills; empty = no skills).",
  "agents.list[].identity.avatar":
    "Avatar image path (relative to the agent workspace only) or a remote URL/data URL.",
  "agents.defaults.heartbeat.suppressToolErrorWarnings":
    "Suppress tool error warning payloads during heartbeat runs.",
  "agents.list[].heartbeat.suppressToolErrorWarnings":
    "Suppress tool error warning payloads during heartbeat runs.",
  "discovery.mdns.mode":
    'mDNS broadcast mode ("minimal" default, "full" includes cliPath/sshPort, "off" disables mDNS).',
  "gateway.auth.token":
    "Required by default for gateway access (unless using Tailscale Serve identity); required for non-loopback binds.",
  "gateway.auth.password": "Required for Tailscale funnel.",
  "gateway.controlUi.basePath":
    "Optional URL prefix where the Control UI is served (e.g. /openclaw).",
  "gateway.controlUi.root":
    "Optional filesystem root for Control UI assets (defaults to dist/control-ui).",
  "gateway.controlUi.allowedOrigins":
    "Allowed browser origins for Control UI/WebChat websocket connections (full origins only, e.g. https://control.example.com).",
  "gateway.controlUi.allowInsecureAuth":
    "Allow Control UI auth over insecure HTTP (token-only; not recommended).",
  "gateway.controlUi.dangerouslyDisableDeviceAuth":
    "DANGEROUS. Disable Control UI device identity checks (token/password only).",
  "gateway.http.endpoints.chatCompletions.enabled":
    "Enable the OpenAI-compatible `POST /v1/chat/completions` endpoint (default: false).",
  "gateway.reload.mode": 'Hot reload strategy for config changes ("hybrid" recommended).',
  "gateway.reload.debounceMs": "Debounce window (ms) before applying config changes.",
  "gateway.nodes.browser.mode":
    'Node browser routing ("auto" = pick single connected browser node, "manual" = require node param, "off" = disable).',
  "gateway.nodes.browser.node": "Pin browser routing to a specific node id or name (optional).",
  "gateway.nodes.allowCommands":
    "Extra node.invoke commands to allow beyond the gateway defaults (array of command strings).",
  "gateway.nodes.denyCommands":
    "Commands to block even if present in node claims or default allowlist.",
  "nodeHost.browserProxy.enabled": "Expose the local browser control server via node proxy.",
  "nodeHost.browserProxy.allowProfiles":
    "Optional allowlist of browser profile names exposed via the node proxy.",
  "diagnostics.flags":
    'Enable targeted diagnostics logs by flag (e.g. ["telegram.http"]). Supports wildcards like "telegram.*" or "*".',
  "diagnostics.cacheTrace.enabled":
    "Log cache trace snapshots for embedded agent runs (default: false).",
  "diagnostics.cacheTrace.filePath":
    "JSONL output path for cache trace logs (default: $OPENCLAW_STATE_DIR/logs/cache-trace.jsonl).",
  "diagnostics.cacheTrace.includeMessages":
    "Include full message payloads in trace output (default: true).",
  "diagnostics.cacheTrace.includePrompt": "Include prompt text in trace output (default: true).",
  "diagnostics.cacheTrace.includeSystem": "Include system prompt in trace output (default: true).",
  "tools.exec.applyPatch.enabled":
    "Experimental. Enables apply_patch for OpenAI models when allowed by tool policy.",
  "tools.exec.applyPatch.workspaceOnly":
    "Restrict apply_patch paths to the workspace directory (default: true). Set false to allow writing outside the workspace (dangerous).",
  "tools.exec.applyPatch.allowModels":
    'Optional allowlist of model ids (e.g. "gpt-5.2" or "openai/gpt-5.2").',
  "tools.loopDetection.enabled":
    "Enable repetitive tool-call loop detection and backoff safety checks (default: false).",
  "tools.loopDetection.historySize": "Tool history window size for loop detection (default: 30).",
  "tools.loopDetection.warningThreshold":
    "Warning threshold for repetitive patterns when detector is enabled (default: 10).",
  "tools.loopDetection.criticalThreshold":
    "Critical threshold for repetitive patterns when detector is enabled (default: 20).",
  "tools.loopDetection.globalCircuitBreakerThreshold":
    "Global no-progress breaker threshold (default: 30).",
  "tools.loopDetection.detectors.genericRepeat":
    "Enable generic repeated same-tool/same-params loop detection (default: true).",
  "tools.loopDetection.detectors.knownPollNoProgress":
    "Enable known poll tool no-progress loop detection (default: true).",
  "tools.loopDetection.detectors.pingPong": "Enable ping-pong loop detection (default: true).",
  "tools.exec.notifyOnExit":
    "When true (default), backgrounded exec sessions enqueue a system event and request a heartbeat on exit.",
  "tools.exec.notifyOnExitEmptySuccess":
    "When true, successful backgrounded exec exits with empty output still enqueue a completion system event (default: false).",
  "tools.exec.pathPrepend": "Directories to prepend to PATH for exec runs (gateway/sandbox).",
  "tools.exec.safeBins":
    "Allow stdin-only safe binaries to run without explicit allowlist entries.",
  "tools.fs.workspaceOnly":
    "Restrict filesystem tools (read/write/edit/apply_patch) to the workspace directory (default: false).",
  "tools.sessions.visibility":
    'Controls which sessions can be targeted by sessions_list/sessions_history/sessions_send. ("tree" default = current session + spawned subagent sessions; "self" = only current; "agent" = any session in the current agent id; "all" = any session; cross-agent still requires tools.agentToAgent).',
  "tools.message.allowCrossContextSend":
    "Legacy override: allow cross-context sends across all providers.",
  "tools.message.crossContext.allowWithinProvider":
    "Allow sends to other channels within the same provider (default: true).",
  "tools.message.crossContext.allowAcrossProviders":
    "Allow sends across different providers (default: false).",
  "tools.message.crossContext.marker.enabled":
    "Add a visible origin marker when sending cross-context (default: true).",
  "tools.message.crossContext.marker.prefix":
    'Text prefix for cross-context markers (supports "{channel}").',
  "tools.message.crossContext.marker.suffix":
    'Text suffix for cross-context markers (supports "{channel}").',
  "tools.message.broadcast.enabled": "Enable broadcast action (default: true).",
  "tools.web.search.enabled": "Enable the web_search tool (requires a provider API key).",
  "tools.web.search.provider": 'Search provider ("brave" or "perplexity").',
  "tools.web.search.apiKey": "Brave Search API key (fallback: BRAVE_API_KEY env var).",
  "tools.web.search.maxResults": "Default number of results to return (1-10).",
  "tools.web.search.timeoutSeconds": "Timeout in seconds for web_search requests.",
  "tools.web.search.cacheTtlMinutes": "Cache TTL in minutes for web_search results.",
  "tools.web.search.perplexity.apiKey":
    "Perplexity or OpenRouter API key (fallback: PERPLEXITY_API_KEY or OPENROUTER_API_KEY env var).",
  "tools.web.search.perplexity.baseUrl":
    "Perplexity base URL override (default: https://openrouter.ai/api/v1 or https://api.perplexity.ai).",
  "tools.web.search.perplexity.model":
    'Perplexity model override (default: "perplexity/sonar-pro").',
  "tools.web.fetch.enabled": "Enable the web_fetch tool (lightweight HTTP fetch).",
  "tools.web.fetch.maxChars": "Max characters returned by web_fetch (truncated).",
  "tools.web.fetch.maxCharsCap":
    "Hard cap for web_fetch maxChars (applies to config and tool calls).",
  "tools.web.fetch.timeoutSeconds": "Timeout in seconds for web_fetch requests.",
  "tools.web.fetch.cacheTtlMinutes": "Cache TTL in minutes for web_fetch results.",
  "tools.web.fetch.maxRedirects": "Maximum redirects allowed for web_fetch (default: 3).",
  "tools.web.fetch.userAgent": "Override User-Agent header for web_fetch requests.",
  "tools.web.fetch.readability":
    "Use Readability to extract main content from HTML (fallbacks to basic HTML cleanup).",
  "tools.web.fetch.firecrawl.enabled": "Enable Firecrawl fallback for web_fetch (if configured).",
  "tools.web.fetch.firecrawl.apiKey": "Firecrawl API key (fallback: FIRECRAWL_API_KEY env var).",
  "tools.web.fetch.firecrawl.baseUrl":
    "Firecrawl base URL (e.g. https://api.firecrawl.dev or custom endpoint).",
  "tools.web.fetch.firecrawl.onlyMainContent":
    "When true, Firecrawl returns only the main content (default: true).",
  "tools.web.fetch.firecrawl.maxAgeMs":
    "Firecrawl maxAge (ms) for cached results when supported by the API.",
  "tools.web.fetch.firecrawl.timeoutSeconds": "Timeout in seconds for Firecrawl requests.",
  "channels.slack.allowBots":
    "Allow bot-authored messages to trigger Slack replies (default: false).",
  "channels.slack.thread.historyScope":
    'Scope for Slack thread history context ("thread" isolates per thread; "channel" reuses channel history).',
  "channels.slack.thread.inheritParent":
    "If true, Slack thread sessions inherit the parent channel transcript (default: false).",
  "channels.slack.thread.initialHistoryLimit":
    "Maximum number of existing Slack thread messages to fetch when starting a new thread session (default: 20, set to 0 to disable).",
  "channels.mattermost.botToken":
    "Bot token from Mattermost System Console -> Integrations -> Bot Accounts.",
  "channels.mattermost.baseUrl":
    "Base URL for your Mattermost server (e.g., https://chat.example.com).",
  "channels.mattermost.chatmode":
    'Reply to channel messages on mention ("oncall"), on trigger chars (">" or "!") ("onchar"), or on every message ("onmessage").',
  "channels.mattermost.oncharPrefixes": 'Trigger prefixes for onchar mode (default: [">", "!"]).',
  "channels.mattermost.requireMention":
    "Require @mention in channels before responding (default: true).",
  "auth.profiles": "Named auth profiles (provider + mode + optional email).",
  "auth.order": "Ordered auth profile IDs per provider (used for automatic failover).",
  "auth.cooldowns.billingBackoffHours":
    "Base backoff (hours) when a profile fails due to billing/insufficient credits (default: 5).",
  "auth.cooldowns.billingBackoffHoursByProvider":
    "Optional per-provider overrides for billing backoff (hours).",
  "auth.cooldowns.billingMaxHours": "Cap (hours) for billing backoff (default: 24).",
  "auth.cooldowns.failureWindowHours": "Failure window (hours) for backoff counters (default: 24).",
  "agents.defaults.bootstrapMaxChars":
    "Max characters of each workspace bootstrap file injected into the system prompt before truncation (default: 20000).",
  "agents.defaults.bootstrapTotalMaxChars":
    "Max total characters across all injected workspace bootstrap files (default: 150000).",
  "agents.defaults.repoRoot":
    "Optional repository root shown in the system prompt runtime line (overrides auto-detect).",
  "agents.defaults.envelopeTimezone":
    'Timezone for message envelopes ("utc", "local", "user", or an IANA timezone string).',
  "agents.defaults.envelopeTimestamp":
    'Include absolute timestamps in message envelopes ("on" or "off").',
  "agents.defaults.envelopeElapsed": 'Include elapsed time in message envelopes ("on" or "off").',
  "agents.defaults.models": "Configured model catalog (keys are full provider/model IDs).",
  "agents.defaults.memorySearch":
    "Vector search over MEMORY.md and memory/*.md (per-agent overrides supported).",
  "agents.defaults.memorySearch.sources":
    'Sources to index for memory search (default: ["memory"]; add "sessions" to include session transcripts).',
  "agents.defaults.memorySearch.extraPaths":
    "Extra paths to include in memory search (directories or .md files; relative paths resolved from workspace).",
  "agents.defaults.memorySearch.experimental.sessionMemory":
    "Enable experimental session transcript indexing for memory search (default: false).",
  "agents.defaults.memorySearch.provider":
    'Embedding provider ("openai", "gemini", "voyage", or "local").',
  "agents.defaults.memorySearch.remote.baseUrl":
    "Custom base URL for remote embeddings (OpenAI-compatible proxies or Gemini overrides).",
  "agents.defaults.memorySearch.remote.apiKey": "Custom API key for the remote embedding provider.",
  "agents.defaults.memorySearch.remote.headers":
    "Extra headers for remote embeddings (merged; remote overrides OpenAI headers).",
  "agents.defaults.memorySearch.remote.batch.enabled":
    "Enable batch API for memory embeddings (OpenAI/Gemini; default: true).",
  "agents.defaults.memorySearch.remote.batch.wait":
    "Wait for batch completion when indexing (default: true).",
  "agents.defaults.memorySearch.remote.batch.concurrency":
    "Max concurrent embedding batch jobs for memory indexing (default: 2).",
  "agents.defaults.memorySearch.remote.batch.pollIntervalMs":
    "Polling interval in ms for batch status (default: 2000).",
  "agents.defaults.memorySearch.remote.batch.timeoutMinutes":
    "Timeout in minutes for batch indexing (default: 60).",
  "agents.defaults.memorySearch.local.modelPath":
    "Local GGUF model path or hf: URI (node-llama-cpp).",
  "agents.defaults.memorySearch.fallback":
    'Fallback provider when embeddings fail ("openai", "gemini", "local", or "none").',
  "agents.defaults.memorySearch.store.path":
    "SQLite index path (default: ~/.openclaw/memory/{agentId}.sqlite).",
  "agents.defaults.memorySearch.store.vector.enabled":
    "Enable sqlite-vec extension for vector search (default: true).",
  "agents.defaults.memorySearch.store.vector.extensionPath":
    "Optional override path to sqlite-vec extension library (.dylib/.so/.dll).",
  "agents.defaults.memorySearch.query.hybrid.enabled":
    "Enable hybrid BM25 + vector search for memory (default: true).",
  "agents.defaults.memorySearch.query.hybrid.vectorWeight":
    "Weight for vector similarity when merging results (0-1).",
  "agents.defaults.memorySearch.query.hybrid.textWeight":
    "Weight for BM25 text relevance when merging results (0-1).",
  "agents.defaults.memorySearch.query.hybrid.candidateMultiplier":
    "Multiplier for candidate pool size (default: 4).",
  "agents.defaults.memorySearch.cache.enabled":
    "Cache chunk embeddings in SQLite to speed up reindexing and frequent updates (default: true).",
  memory: "Memory backend configuration (global).",
  "memory.backend": 'Memory backend ("builtin" for OpenClaw embeddings, "qmd" for QMD sidecar).',
  "memory.citations": 'Default citation behavior ("auto", "on", or "off").',
  "memory.qmd.command": "Path to the qmd binary (default: resolves from PATH).",
  "memory.qmd.includeDefaultMemory":
    "Whether to automatically index MEMORY.md + memory/**/*.md (default: true).",
  "memory.qmd.paths":
    "Additional directories/files to index with QMD (path + optional glob pattern).",
  "memory.qmd.paths.path": "Absolute or ~-relative path to index via QMD.",
  "memory.qmd.paths.pattern": "Glob pattern relative to the path root (default: **/*.md).",
  "memory.qmd.paths.name":
    "Optional stable name for the QMD collection (default derived from path).",
  "memory.qmd.sessions.enabled":
    "Enable QMD session transcript indexing (experimental, default: false).",
  "memory.qmd.sessions.exportDir":
    "Override directory for sanitized session exports before indexing.",
  "memory.qmd.sessions.retentionDays":
    "Retention window for exported sessions before pruning (default: unlimited).",
  "memory.qmd.update.interval":
    "How often the QMD sidecar refreshes indexes (duration string, default: 5m).",
  "memory.qmd.update.debounceMs":
    "Minimum delay between successive QMD refresh runs (default: 15000).",
  "memory.qmd.update.onBoot": "Run QMD update once on gateway startup (default: true).",
  "memory.qmd.update.waitForBootSync":
    "Block startup until the boot QMD refresh finishes (default: false).",
  "memory.qmd.update.embedInterval":
    "How often QMD embeddings are refreshed (duration string, default: 60m). Set to 0 to disable periodic embed.",
  "memory.qmd.update.commandTimeoutMs":
    "Timeout for QMD maintenance commands like collection list/add (default: 30000).",
  "memory.qmd.update.updateTimeoutMs": "Timeout for `qmd update` runs (default: 120000).",
  "memory.qmd.update.embedTimeoutMs": "Timeout for `qmd embed` runs (default: 120000).",
  "memory.qmd.limits.maxResults": "Max QMD results returned to the agent loop (default: 6).",
  "memory.qmd.limits.maxSnippetChars": "Max characters per snippet pulled from QMD (default: 700).",
  "memory.qmd.limits.maxInjectedChars": "Max total characters injected from QMD hits per turn.",
  "memory.qmd.limits.timeoutMs": "Per-query timeout for QMD searches (default: 4000).",
  "memory.qmd.scope":
    "Session/channel scope for QMD recall (same syntax as session.sendPolicy; default: direct-only). Use match.rawKeyPrefix to match full agent-prefixed session keys.",
  "agents.defaults.memorySearch.cache.maxEntries":
    "Optional cap on cached embeddings (best-effort).",
  "agents.defaults.memorySearch.sync.onSearch":
    "Lazy sync: schedule a reindex on search after changes.",
  "agents.defaults.memorySearch.sync.watch": "Watch memory files for changes (chokidar).",
  "agents.defaults.memorySearch.sync.sessions.deltaBytes":
    "Minimum appended bytes before session transcripts trigger reindex (default: 100000).",
  "agents.defaults.memorySearch.sync.sessions.deltaMessages":
    "Minimum appended JSONL lines before session transcripts trigger reindex (default: 50).",
  "plugins.enabled": "Enable plugin/extension loading (default: true).",
  "plugins.allow": "Optional allowlist of plugin ids; when set, only listed plugins load.",
  "plugins.deny": "Optional denylist of plugin ids; deny wins over allowlist.",
  "plugins.load.paths": "Additional plugin files or directories to load.",
  "plugins.runtime.allowLegacyExec":
    "Opt-in compatibility switch to re-enable deprecated runtime.system.runCommandWithTimeout for legacy plugins (default: false).",
  "plugins.slots": "Select which plugins own exclusive slots (memory, etc.).",
  "plugins.slots.memory":
    'Select the active memory plugin by id, or "none" to disable memory plugins.',
  "plugins.entries": "Per-plugin settings keyed by plugin id (enable/disable + config payloads).",
  "plugins.entries.*.enabled": "Overrides plugin enable/disable for this entry (restart required).",
  "plugins.entries.*.config": "Plugin-defined config payload (schema is provided by the plugin).",
  "plugins.installs":
    "CLI-managed install metadata (used by `openclaw plugins update` to locate install sources).",
  "plugins.installs.*.source": 'Install source ("npm", "archive", or "path").',
  "plugins.installs.*.spec": "Original npm spec used for install (if source is npm).",
  "plugins.installs.*.sourcePath": "Original archive/path used for install (if any).",
  "plugins.installs.*.installPath":
    "Resolved install directory (usually ~/.openclaw/extensions/<id>).",
  "plugins.installs.*.version": "Version recorded at install time (if available).",
  "plugins.installs.*.installedAt": "ISO timestamp of last install/update.",
  "agents.list.*.identity.avatar":
    "Agent avatar (workspace-relative path, http(s) URL, or data URI).",
  "agents.defaults.model.primary": "Primary model (provider/model).",
  "agents.defaults.model.fallbacks":
    "Ordered fallback models (provider/model). Used when the primary model fails.",
  "agents.defaults.imageModel.primary":
    "Optional image model (provider/model) used when the primary model lacks image input.",
  "agents.defaults.imageModel.fallbacks": "Ordered fallback image models (provider/model).",
  "agents.defaults.imageMaxDimensionPx":
    "Max image side length in pixels when sanitizing transcript/tool-result image payloads (default: 1200).",
  "agents.defaults.cliBackends": "Optional CLI backends for text-only fallback (claude-cli, etc.).",
  "agents.defaults.humanDelay.mode": 'Delay style for block replies ("off", "natural", "custom").',
  "agents.defaults.humanDelay.minMs": "Minimum delay in ms for custom humanDelay (default: 800).",
  "agents.defaults.humanDelay.maxMs": "Maximum delay in ms for custom humanDelay (default: 2500).",
  "commands.native":
    "Register native commands with channels that support it (Discord/Slack/Telegram).",
  "commands.nativeSkills":
    "Register native skill commands (user-invocable skills) with channels that support it.",
  "commands.text": "Allow text command parsing (slash commands only).",
  "commands.bash":
    "Allow bash chat command (`!`; `/bash` alias) to run host shell commands (default: false; requires tools.elevated).",
  "commands.bashForegroundMs":
    "How long bash waits before backgrounding (default: 2000; 0 backgrounds immediately).",
  "commands.config": "Allow /config chat command to read/write config on disk (default: false).",
  "commands.debug": "Allow /debug chat command for runtime-only overrides (default: false).",
  "commands.restart": "Allow /restart and gateway restart tool actions (default: true).",
  "commands.useAccessGroups": "Enforce access-group allowlists/policies for commands.",
  "commands.ownerAllowFrom":
    "Explicit owner allowlist for owner-only tools/commands. Use channel-native IDs (optionally prefixed like \"whatsapp:+15551234567\"). '*' is ignored.",
  "session.dmScope":
    'DM session scoping: "main" keeps continuity; "per-peer", "per-channel-peer", or "per-account-channel-peer" isolates DM history (recommended for shared inboxes/multi-account).',
  "session.identityLinks":
    "Map canonical identities to provider-prefixed peer IDs for DM session linking (example: telegram:123456).",
  "channels.telegram.configWrites":
    "Allow Telegram to write config in response to channel events/commands (default: true).",
  "channels.slack.configWrites":
    "Allow Slack to write config in response to channel events/commands (default: true).",
  "channels.mattermost.configWrites":
    "Allow Mattermost to write config in response to channel events/commands (default: true).",
  "channels.discord.configWrites":
    "Allow Discord to write config in response to channel events/commands (default: true).",
  "channels.discord.proxy":
    "Proxy URL for Discord gateway + API requests (app-id lookup and allowlist resolution). Set per account via channels.discord.accounts.<id>.proxy.",
  "channels.whatsapp.configWrites":
    "Allow WhatsApp to write config in response to channel events/commands (default: true).",
  "channels.signal.configWrites":
    "Allow Signal to write config in response to channel events/commands (default: true).",
  "channels.imessage.configWrites":
    "Allow iMessage to write config in response to channel events/commands (default: true).",
  "channels.msteams.configWrites":
    "Allow Microsoft Teams to write config in response to channel events/commands (default: true).",
  ...IRC_FIELD_HELP,
  "channels.discord.commands.native": 'Override native commands for Discord (bool or "auto").',
  "channels.discord.commands.nativeSkills":
    'Override native skill commands for Discord (bool or "auto").',
  "channels.telegram.commands.native": 'Override native commands for Telegram (bool or "auto").',
  "channels.telegram.commands.nativeSkills":
    'Override native skill commands for Telegram (bool or "auto").',
  "channels.slack.commands.native": 'Override native commands for Slack (bool or "auto").',
  "channels.slack.commands.nativeSkills":
    'Override native skill commands for Slack (bool or "auto").',
  "channels.slack.streamMode":
    "Live stream preview mode for Slack replies (replace | status_final | append).",
  "session.agentToAgent.maxPingPongTurns":
    "Max reply-back turns between requester and target (0–5).",
  "channels.telegram.customCommands":
    "Additional Telegram bot menu commands (merged with native; conflicts ignored).",
  "messages.suppressToolErrors":
    "When true, suppress ⚠️ tool-error warnings from being shown to the user. The agent already sees errors in context and can retry. Default: false.",
  "messages.ackReaction": "Emoji reaction used to acknowledge inbound messages (empty disables).",
  "messages.ackReactionScope":
    'When to send ack reactions ("group-mentions", "group-all", "direct", "all").',
  "messages.inbound.debounceMs":
    "Debounce window (ms) for batching rapid inbound messages from the same sender (0 to disable).",
  "channels.telegram.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.telegram.allowFrom=["*"].',
  "channels.telegram.streamMode":
    "Live stream preview mode for Telegram replies (off | partial | block). Separate from block streaming; uses sendMessage + editMessageText.",
  "channels.telegram.draftChunk.minChars":
    'Minimum chars before emitting a Telegram stream preview update when channels.telegram.streamMode="block" (default: 200).',
  "channels.telegram.draftChunk.maxChars":
    'Target max size for a Telegram stream preview chunk when channels.telegram.streamMode="block" (default: 800; clamped to channels.telegram.textChunkLimit).',
  "channels.telegram.draftChunk.breakPreference":
    "Preferred breakpoints for Telegram draft chunks (paragraph | newline | sentence). Default: paragraph.",
  "channels.telegram.retry.attempts":
    "Max retry attempts for outbound Telegram API calls (default: 3).",
  "channels.telegram.retry.minDelayMs": "Minimum retry delay in ms for Telegram outbound calls.",
  "channels.telegram.retry.maxDelayMs":
    "Maximum retry delay cap in ms for Telegram outbound calls.",
  "channels.telegram.retry.jitter": "Jitter factor (0-1) applied to Telegram retry delays.",
  "channels.telegram.network.autoSelectFamily":
    "Override Node autoSelectFamily for Telegram (true=enable, false=disable).",
  "channels.telegram.timeoutSeconds":
    "Max seconds before Telegram API requests are aborted (default: 500 per grammY).",
  "channels.whatsapp.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.whatsapp.allowFrom=["*"].',
  "channels.whatsapp.selfChatMode": "Same-phone setup (bot uses your personal WhatsApp number).",
  "channels.whatsapp.debounceMs":
    "Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable).",
  "channels.signal.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.signal.allowFrom=["*"].',
  "channels.imessage.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.imessage.allowFrom=["*"].',
  "channels.bluebubbles.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.bluebubbles.allowFrom=["*"].',
  "channels.discord.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.discord.allowFrom=["*"].',
  "channels.discord.dm.policy":
    'Direct message access control ("pairing" recommended). "open" requires channels.discord.allowFrom=["*"] (legacy: channels.discord.dm.allowFrom).',
  "channels.discord.retry.attempts":
    "Max retry attempts for outbound Discord API calls (default: 3).",
  "channels.discord.retry.minDelayMs": "Minimum retry delay in ms for Discord outbound calls.",
  "channels.discord.retry.maxDelayMs": "Maximum retry delay cap in ms for Discord outbound calls.",
  "channels.discord.retry.jitter": "Jitter factor (0-1) applied to Discord retry delays.",
  "channels.discord.maxLinesPerMessage": "Soft max line count per Discord message (default: 17).",
  "channels.discord.ui.components.accentColor":
    "Accent color for Discord component containers (hex). Set per account via channels.discord.accounts.<id>.ui.components.accentColor.",
  "channels.discord.intents.presence":
    "Enable the Guild Presences privileged intent. Must also be enabled in the Discord Developer Portal. Allows tracking user activities (e.g. Spotify). Default: false.",
  "channels.discord.intents.guildMembers":
    "Enable the Guild Members privileged intent. Must also be enabled in the Discord Developer Portal. Default: false.",
  "channels.discord.pluralkit.enabled":
    "Resolve PluralKit proxied messages and treat system members as distinct senders.",
  "channels.discord.pluralkit.token":
    "Optional PluralKit token for resolving private systems or members.",
  "channels.discord.activity": "Discord presence activity text (defaults to custom status).",
  "channels.discord.status": "Discord presence status (online, dnd, idle, invisible).",
  "channels.discord.activityType":
    "Discord presence activity type (0=Playing,1=Streaming,2=Listening,3=Watching,4=Custom,5=Competing).",
  "channels.discord.activityUrl": "Discord presence streaming URL (required for activityType=1).",
  "channels.slack.dm.policy":
    'Direct message access control ("pairing" recommended). "open" requires channels.slack.allowFrom=["*"] (legacy: channels.slack.dm.allowFrom).',
  "channels.slack.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.slack.allowFrom=["*"].',
};
