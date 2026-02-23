import { IRC_FIELD_HELP } from "./schema.irc.js";

export const FIELD_HELP: Record<string, string> = {
  meta: "Metadata fields automatically maintained by OpenClaw to record write/version history for this config file. Keep these values system-managed and avoid manual edits unless debugging migration history.",
  "meta.lastTouchedVersion": "Auto-set when OpenClaw writes the config.",
  "meta.lastTouchedAt": "ISO timestamp of the last config write (auto-set).",
  env: "Environment import and override settings used to supply runtime variables to the gateway process. Use this section to control shell-env loading and explicit variable injection behavior.",
  "env.shellEnv":
    "Shell environment import controls for loading variables from your login shell during startup. Keep this enabled when you depend on profile-defined secrets or PATH customizations.",
  "env.shellEnv.enabled":
    "Enables loading environment variables from the user shell profile during startup initialization. Keep enabled for developer machines, or disable in locked-down service environments with explicit env management.",
  "env.shellEnv.timeoutMs":
    "Maximum time in milliseconds allowed for shell environment resolution before fallback behavior applies. Use tighter timeouts for faster startup, or increase when shell initialization is heavy.",
  "env.vars":
    "Explicit key/value environment variable overrides merged into runtime process environment for OpenClaw. Use this for deterministic env configuration instead of relying only on shell profile side effects.",
  wizard:
    "Setup wizard state tracking fields that record the most recent guided onboarding run details. Keep these fields for observability and troubleshooting of setup flows across upgrades.",
  "wizard.lastRunAt":
    "ISO timestamp for when the setup wizard most recently completed on this host. Use this to confirm onboarding recency during support and operational audits.",
  "wizard.lastRunVersion":
    "OpenClaw version recorded at the time of the most recent wizard run on this config. Use this when diagnosing behavior differences across version-to-version onboarding changes.",
  "wizard.lastRunCommit":
    "Source commit identifier recorded for the last wizard execution in development builds. Use this to correlate onboarding behavior with exact source state during debugging.",
  "wizard.lastRunCommand":
    "Command invocation recorded for the latest wizard run to preserve execution context. Use this to reproduce onboarding steps when verifying setup regressions.",
  "wizard.lastRunMode":
    'Wizard execution mode recorded as "local" or "remote" for the most recent onboarding flow. Use this to understand whether setup targeted direct local runtime or remote gateway topology.',
  diagnostics:
    "Diagnostics controls for targeted tracing, telemetry export, and cache inspection during debugging. Keep baseline diagnostics minimal in production and enable deeper signals only when investigating issues.",
  "diagnostics.otel":
    "OpenTelemetry export settings for traces, metrics, and logs emitted by gateway components. Use this when integrating with centralized observability backends and distributed tracing pipelines.",
  "diagnostics.cacheTrace":
    "Cache-trace logging settings for observing cache decisions and payload context in embedded runs. Enable this temporarily for debugging and disable afterward to reduce sensitive log footprint.",
  logging:
    "Logging behavior controls for severity, output destinations, formatting, and sensitive-data redaction. Keep levels and redaction strict enough for production while preserving useful diagnostics.",
  "logging.level":
    'Primary log level threshold for runtime logger output: "silent", "fatal", "error", "warn", "info", "debug", or "trace". Keep "info" or "warn" for production, and use debug/trace only during investigation.',
  "logging.file":
    "Optional file path for persisted log output in addition to or instead of console logging. Use a managed writable path and align retention/rotation with your operational policy.",
  "logging.consoleLevel":
    'Console-specific log threshold: "silent", "fatal", "error", "warn", "info", "debug", or "trace" for terminal output control. Use this to keep local console quieter while retaining richer file logging if needed.',
  "logging.consoleStyle":
    'Console output format style: "pretty", "compact", or "json" based on operator and ingestion needs. Use json for machine parsing pipelines and pretty/compact for human-first terminal workflows.',
  "logging.redactSensitive":
    'Sensitive redaction mode: "off" disables built-in masking, while "tools" redacts sensitive tool/config payload fields. Keep "tools" in shared logs unless you have isolated secure log sinks.',
  "logging.redactPatterns":
    "Additional custom redact regex patterns applied to log output before emission/storage. Use this to mask org-specific tokens and identifiers not covered by built-in redaction rules.",
  update:
    "Update-channel and startup-check behavior for keeping OpenClaw runtime versions current. Use conservative channels in production and more experimental channels only in controlled environments.",
  "update.channel": 'Update channel for git + npm installs ("stable", "beta", or "dev").',
  "update.checkOnStart": "Check for npm updates when the gateway starts (default: true).",
  "update.auto.enabled": "Enable background auto-update for package installs (default: false).",
  "update.auto.stableDelayHours":
    "Minimum delay before stable-channel auto-apply starts (default: 6).",
  "update.auto.stableJitterHours":
    "Extra stable-channel rollout spread window in hours (default: 12).",
  "update.auto.betaCheckIntervalHours": "How often beta-channel checks run in hours (default: 1).",
  gateway:
    "Gateway runtime surface for bind mode, auth, control UI, remote transport, and operational safety controls. Keep conservative defaults unless you intentionally expose the gateway beyond trusted local interfaces.",
  "gateway.port":
    "TCP port used by the gateway listener for API, control UI, and channel-facing ingress paths. Use a dedicated port and avoid collisions with reverse proxies or local developer services.",
  "gateway.mode":
    'Gateway operation mode: "local" runs channels and agent runtime on this host, while "remote" connects through remote transport. Keep "local" unless you intentionally run a split remote gateway topology.',
  "gateway.bind":
    'Network bind profile: "auto", "lan", "loopback", "custom", or "tailnet" to control interface exposure. Keep "loopback" or "auto" for safest local operation unless external clients must connect.',
  "gateway.customBindHost":
    "Explicit bind host/IP used when gateway.bind is set to custom for manual interface targeting. Use a precise address and avoid wildcard binds unless external exposure is required.",
  "gateway.controlUi":
    "Control UI hosting settings including enablement, pathing, and browser-origin/auth hardening behavior. Keep UI exposure minimal and pair with strong auth controls before internet-facing deployments.",
  "gateway.controlUi.enabled":
    "Enables serving the gateway Control UI from the gateway HTTP process when true. Keep enabled for local administration, and disable when an external control surface replaces it.",
  "gateway.auth":
    "Authentication policy for gateway HTTP/WebSocket access including mode, credentials, trusted-proxy behavior, and rate limiting. Keep auth enabled for every non-loopback deployment.",
  "gateway.auth.mode":
    'Gateway auth mode: "none", "token", "password", or "trusted-proxy" depending on your edge architecture. Use token/password for direct exposure, and trusted-proxy only behind hardened identity-aware proxies.',
  "gateway.auth.allowTailscale":
    "Allows trusted Tailscale identity paths to satisfy gateway auth checks when configured. Use this only when your tailnet identity posture is strong and operator workflows depend on it.",
  "gateway.auth.rateLimit":
    "Login/auth attempt throttling controls to reduce credential brute-force risk at the gateway boundary. Keep enabled in exposed environments and tune thresholds to your traffic baseline.",
  "gateway.auth.trustedProxy":
    "Trusted-proxy auth header mapping for upstream identity providers that inject user claims. Use only with known proxy CIDRs and strict header allowlists to prevent spoofed identity headers.",
  "gateway.trustedProxies":
    "CIDR/IP allowlist of upstream proxies permitted to provide forwarded client identity headers. Keep this list narrow so untrusted hops cannot impersonate users.",
  "gateway.allowRealIpFallback":
    "Enables x-real-ip fallback when x-forwarded-for is missing in proxy scenarios. Keep disabled unless your ingress stack requires this compatibility behavior.",
  "gateway.tools":
    "Gateway-level tool exposure allow/deny policy that can restrict runtime tool availability independent of agent/tool profiles. Use this for coarse emergency controls and production hardening.",
  "gateway.tools.allow":
    "Explicit gateway-level tool allowlist when you want a narrow set of tools available at runtime. Use this for locked-down environments where tool scope must be tightly controlled.",
  "gateway.tools.deny":
    "Explicit gateway-level tool denylist to block risky tools even if lower-level policies allow them. Use deny rules for emergency response and defense-in-depth hardening.",
  "gateway.channelHealthCheckMinutes":
    "Interval in minutes for automatic channel health probing and status updates. Use lower intervals for faster detection, or higher intervals to reduce periodic probe noise.",
  "gateway.tailscale":
    "Tailscale integration settings for Serve/Funnel exposure and lifecycle handling on gateway start/exit. Keep off unless your deployment intentionally relies on Tailscale ingress.",
  "gateway.tailscale.mode":
    'Tailscale publish mode: "off", "serve", or "funnel" for private or public exposure paths. Use "serve" for tailnet-only access and "funnel" only when public internet reachability is required.',
  "gateway.tailscale.resetOnExit":
    "Resets Tailscale Serve/Funnel state on gateway exit to avoid stale published routes after shutdown. Keep enabled unless another controller manages publish lifecycle outside the gateway.",
  "gateway.remote":
    "Remote gateway connection settings for direct or SSH transport when this instance proxies to another runtime host. Use remote mode only when split-host operation is intentionally configured.",
  "gateway.remote.transport":
    'Remote connection transport: "direct" uses configured URL connectivity, while "ssh" tunnels through SSH. Use SSH when you need encrypted tunnel semantics without exposing remote ports.',
  "gateway.reload":
    "Live config-reload policy for how edits are applied and when full restarts are triggered. Keep hybrid behavior for safest operational updates unless debugging reload internals.",
  "gateway.tls":
    "TLS certificate and key settings for terminating HTTPS directly in the gateway process. Use explicit certificates in production and avoid plaintext exposure on untrusted networks.",
  "gateway.tls.enabled":
    "Enables TLS termination at the gateway listener so clients connect over HTTPS/WSS directly. Keep enabled for direct internet exposure or any untrusted network boundary.",
  "gateway.tls.autoGenerate":
    "Auto-generates a local TLS certificate/key pair when explicit files are not configured. Use only for local/dev setups and replace with real certificates for production traffic.",
  "gateway.tls.certPath":
    "Filesystem path to the TLS certificate file used by the gateway when TLS is enabled. Use managed certificate paths and keep renewal automation aligned with this location.",
  "gateway.tls.keyPath":
    "Filesystem path to the TLS private key file used by the gateway when TLS is enabled. Keep this key file permission-restricted and rotate per your security policy.",
  "gateway.tls.caPath":
    "Optional CA bundle path for client verification or custom trust-chain requirements at the gateway edge. Use this when private PKI or custom certificate chains are part of deployment.",
  "gateway.http":
    "Gateway HTTP API configuration grouping endpoint toggles and transport-facing API exposure controls. Keep only required endpoints enabled to reduce attack surface.",
  "gateway.http.endpoints":
    "HTTP endpoint feature toggles under the gateway API surface for compatibility routes and optional integrations. Enable endpoints intentionally and monitor access patterns after rollout.",
  "gateway.http.securityHeaders":
    "Optional HTTP response security headers applied by the gateway process itself. Prefer setting these at your reverse proxy when TLS terminates there.",
  "gateway.http.securityHeaders.strictTransportSecurity":
    "Value for the Strict-Transport-Security response header. Set only on HTTPS origins that you fully control; use false to explicitly disable.",
  "gateway.remote.url": "Remote Gateway WebSocket URL (ws:// or wss://).",
  "gateway.remote.token":
    "Bearer token used to authenticate this client to a remote gateway in token-auth deployments. Store via secret/env substitution and rotate alongside remote gateway auth changes.",
  "gateway.remote.password":
    "Password credential used for remote gateway authentication when password mode is enabled. Keep this secret managed externally and avoid plaintext values in committed config.",
  "gateway.remote.tlsFingerprint":
    "Expected sha256 TLS fingerprint for the remote gateway (pin to avoid MITM).",
  "gateway.remote.sshTarget":
    "Remote gateway over SSH (tunnels the gateway port to localhost). Format: user@host or user@host:port.",
  "gateway.remote.sshIdentity": "Optional SSH identity file path (passed to ssh -i).",
  "agents.list.*.skills":
    "Optional allowlist of skills for this agent (omit = all skills; empty = no skills).",
  "agents.list[].skills":
    "Optional allowlist of skills for this agent (omit = all skills; empty = no skills).",
  agents:
    "Agent runtime configuration root covering defaults and explicit agent entries used for routing and execution context. Keep this section explicit so model/tool behavior stays predictable across multi-agent workflows.",
  "agents.defaults":
    "Shared default settings inherited by agents unless overridden per entry in agents.list. Use defaults to enforce consistent baseline behavior and reduce duplicated per-agent configuration.",
  "agents.list":
    "Explicit list of configured agents with IDs and optional overrides for model, tools, identity, and workspace. Keep IDs stable over time so bindings, approvals, and session routing remain deterministic.",
  "agents.list[].identity.avatar":
    "Avatar image path (relative to the agent workspace only) or a remote URL/data URL.",
  "agents.defaults.heartbeat.suppressToolErrorWarnings":
    "Suppress tool error warning payloads during heartbeat runs.",
  "agents.list[].heartbeat.suppressToolErrorWarnings":
    "Suppress tool error warning payloads during heartbeat runs.",
  browser:
    "Browser runtime controls for local or remote CDP attachment, profile routing, and screenshot/snapshot behavior. Keep defaults unless your automation workflow requires custom browser transport settings.",
  "browser.enabled":
    "Enables browser capability wiring in the gateway so browser tools and CDP-driven workflows can run. Disable when browser automation is not needed to reduce surface area and startup work.",
  "browser.cdpUrl":
    "Remote CDP websocket URL used to attach to an externally managed browser instance. Use this for centralized browser hosts and keep URL access restricted to trusted network paths.",
  "browser.color":
    "Default accent color used for browser profile/UI cues where colored identity hints are displayed. Use consistent colors to help operators identify active browser profile context quickly.",
  "browser.executablePath":
    "Explicit browser executable path when auto-discovery is insufficient for your host environment. Use absolute stable paths so launch behavior stays deterministic across restarts.",
  "browser.headless":
    "Forces browser launch in headless mode when the local launcher starts browser instances. Keep headless enabled for server environments and disable only when visible UI debugging is required.",
  "browser.noSandbox":
    "Disables Chromium sandbox isolation flags for environments where sandboxing fails at runtime. Keep this off whenever possible because process isolation protections are reduced.",
  "browser.attachOnly":
    "Restricts browser mode to attach-only behavior without starting local browser processes. Use this when all browser sessions are externally managed by a remote CDP provider.",
  "browser.defaultProfile":
    "Default browser profile name selected when callers do not explicitly choose a profile. Use a stable low-privilege profile as the default to reduce accidental cross-context state use.",
  "browser.profiles":
    "Named browser profile connection map used for explicit routing to CDP ports or URLs with optional metadata. Keep profile names consistent and avoid overlapping endpoint definitions.",
  "browser.profiles.*.cdpPort":
    "Per-profile local CDP port used when connecting to browser instances by port instead of URL. Use unique ports per profile to avoid connection collisions.",
  "browser.profiles.*.cdpUrl":
    "Per-profile CDP websocket URL used for explicit remote browser routing by profile name. Use this when profile connections terminate on remote hosts or tunnels.",
  "browser.profiles.*.driver":
    'Per-profile browser driver mode: "clawd" or "extension" depending on connection/runtime strategy. Use the driver that matches your browser control stack to avoid protocol mismatches.',
  "browser.profiles.*.color":
    "Per-profile accent color for visual differentiation in dashboards and browser-related UI hints. Use distinct colors for high-signal operator recognition of active profiles.",
  "browser.evaluateEnabled":
    "Enables browser-side evaluate helpers for runtime script evaluation capabilities where supported. Keep disabled unless your workflows require evaluate semantics beyond snapshots/navigation.",
  "browser.snapshotDefaults":
    "Default snapshot capture configuration used when callers do not provide explicit snapshot options. Tune this for consistent capture behavior across channels and automation paths.",
  "browser.snapshotDefaults.mode":
    "Default snapshot extraction mode controlling how page content is transformed for agent consumption. Choose the mode that balances readability, fidelity, and token footprint for your workflows.",
  "browser.ssrfPolicy":
    "Server-side request forgery guardrail settings for browser/network fetch paths that could reach internal hosts. Keep restrictive defaults in production and open only explicitly approved targets.",
  "browser.ssrfPolicy.allowPrivateNetwork":
    "Allows access to private-network address ranges from browser/network tooling when SSRF protections are active. Keep disabled unless internal-network access is required and separately controlled.",
  "browser.ssrfPolicy.allowedHostnames":
    "Explicit hostname allowlist exceptions for SSRF policy checks on browser/network requests. Keep this list minimal and review entries regularly to avoid stale broad access.",
  "browser.ssrfPolicy.hostnameAllowlist":
    "Legacy/alternate hostname allowlist field used by SSRF policy consumers for explicit host exceptions. Use stable exact hostnames and avoid wildcard-like broad patterns.",
  "browser.remoteCdpTimeoutMs":
    "Timeout in milliseconds for connecting to a remote CDP endpoint before failing the browser attach attempt. Increase for high-latency tunnels, or lower for faster failure detection.",
  "browser.remoteCdpHandshakeTimeoutMs":
    "Timeout in milliseconds for post-connect CDP handshake readiness checks against remote browser targets. Raise this for slow-start remote browsers and lower to fail fast in automation loops.",
  "discovery.mdns.mode":
    'mDNS broadcast mode ("minimal" default, "full" includes cliPath/sshPort, "off" disables mDNS).',
  discovery:
    "Service discovery settings for local mDNS advertisement and optional wide-area presence signaling. Keep discovery scoped to expected networks to avoid leaking service metadata.",
  "discovery.wideArea":
    "Wide-area discovery configuration group for exposing discovery signals beyond local-link scopes. Enable only in deployments that intentionally aggregate gateway presence across sites.",
  "discovery.wideArea.enabled":
    "Enables wide-area discovery signaling when your environment needs non-local gateway discovery. Keep disabled unless cross-network discovery is operationally required.",
  "discovery.mdns":
    "mDNS discovery configuration group for local network advertisement and discovery behavior tuning. Keep minimal mode for routine LAN discovery unless extra metadata is required.",
  tools:
    "Global tool access policy and capability configuration across web, exec, media, messaging, and elevated surfaces. Use this section to constrain risky capabilities before broad rollout.",
  "tools.allow":
    "Absolute tool allowlist that replaces profile-derived defaults for strict environments. Use this only when you intentionally run a tightly curated subset of tool capabilities.",
  "tools.deny":
    "Global tool denylist that blocks listed tools even when profile or provider rules would allow them. Use deny rules for emergency lockouts and long-term defense-in-depth.",
  "tools.web":
    "Web-tool policy grouping for search/fetch providers, limits, and fallback behavior tuning. Keep enabled settings aligned with API key availability and outbound networking policy.",
  "tools.exec":
    "Exec-tool policy grouping for shell execution host, security mode, approval behavior, and runtime bindings. Keep conservative defaults in production and tighten elevated execution paths.",
  "tools.exec.host":
    "Selects execution host strategy for shell commands, typically controlling local vs delegated execution environment. Use the safest host mode that still satisfies your automation requirements.",
  "tools.exec.security":
    "Execution security posture selector controlling sandbox/approval expectations for command execution. Keep strict security mode for untrusted prompts and relax only for trusted operator workflows.",
  "tools.exec.ask":
    "Approval strategy for when exec commands require human confirmation before running. Use stricter ask behavior in shared channels and lower-friction settings in private operator contexts.",
  "tools.exec.node":
    "Node binding configuration for exec tooling when command execution is delegated through connected nodes. Use explicit node binding only when multi-node routing is required.",
  "tools.agentToAgent":
    "Policy for allowing agent-to-agent tool calls and constraining which target agents can be reached. Keep disabled or tightly scoped unless cross-agent orchestration is intentionally enabled.",
  "tools.agentToAgent.enabled":
    "Enables the agent_to_agent tool surface so one agent can invoke another agent at runtime. Keep off in simple deployments and enable only when orchestration value outweighs complexity.",
  "tools.agentToAgent.allow":
    "Allowlist of target agent IDs permitted for agent_to_agent calls when orchestration is enabled. Use explicit allowlists to avoid uncontrolled cross-agent call graphs.",
  "tools.elevated":
    "Elevated tool access controls for privileged command surfaces that should only be reachable from trusted senders. Keep disabled unless operator workflows explicitly require elevated actions.",
  "tools.elevated.enabled":
    "Enables elevated tool execution path when sender and policy checks pass. Keep disabled in public/shared channels and enable only for trusted owner-operated contexts.",
  "tools.elevated.allowFrom":
    "Sender allow rules for elevated tools, usually keyed by channel/provider identity formats. Use narrow, explicit identities so elevated commands cannot be triggered by unintended users.",
  "tools.subagents":
    "Tool policy wrapper for spawned subagents to restrict or expand tool availability compared to parent defaults. Use this to keep delegated agent capabilities scoped to task intent.",
  "tools.subagents.tools":
    "Allow/deny tool policy applied to spawned subagent runtimes for per-subagent hardening. Keep this narrower than parent scope when subagents run semi-autonomous workflows.",
  "tools.sandbox":
    "Tool policy wrapper for sandboxed agent executions so sandbox runs can have distinct capability boundaries. Use this to enforce stronger safety in sandbox contexts.",
  "tools.sandbox.tools":
    "Allow/deny tool policy applied when agents run in sandboxed execution environments. Keep policies minimal so sandbox tasks cannot escalate into unnecessary external actions.",
  web: "Web channel runtime settings for heartbeat and reconnect behavior when operating web-based chat surfaces. Use reconnect values tuned to your network reliability profile and expected uptime needs.",
  "web.enabled":
    "Enables the web channel runtime and related websocket lifecycle behavior. Keep disabled when web chat is unused to reduce active connection management overhead.",
  "web.heartbeatSeconds":
    "Heartbeat interval in seconds for web channel connectivity and liveness maintenance. Use shorter intervals for faster detection, or longer intervals to reduce keepalive chatter.",
  "web.reconnect":
    "Reconnect backoff policy for web channel reconnect attempts after transport failure. Keep bounded retries and jitter tuned to avoid thundering-herd reconnect behavior.",
  "web.reconnect.initialMs":
    "Initial reconnect delay in milliseconds before the first retry after disconnection. Use modest delays to recover quickly without immediate retry storms.",
  "web.reconnect.maxMs":
    "Maximum reconnect backoff cap in milliseconds to bound retry delay growth over repeated failures. Use a reasonable cap so recovery remains timely after prolonged outages.",
  "web.reconnect.factor":
    "Exponential backoff multiplier used between reconnect attempts in web channel retry loops. Keep factor above 1 and tune with jitter for stable large-fleet reconnect behavior.",
  "web.reconnect.jitter":
    "Randomization factor (0-1) applied to reconnect delays to desynchronize clients after outage events. Keep non-zero jitter in multi-client deployments to reduce synchronized spikes.",
  "web.reconnect.maxAttempts":
    "Maximum reconnect attempts before giving up for the current failure sequence (0 means no retries). Use finite caps for controlled failure handling in automation-sensitive environments.",
  canvasHost:
    "Canvas host settings for serving canvas assets and local live-reload behavior used by canvas-enabled workflows. Keep disabled unless canvas-hosted assets are actively used.",
  "canvasHost.enabled":
    "Enables the canvas host server process and routes for serving canvas files. Keep disabled when canvas workflows are inactive to reduce exposed local services.",
  "canvasHost.root":
    "Filesystem root directory served by canvas host for canvas content and static assets. Use a dedicated directory and avoid broad repo roots for least-privilege file exposure.",
  "canvasHost.port":
    "TCP port used by the canvas host HTTP server when canvas hosting is enabled. Choose a non-conflicting port and align firewall/proxy policy accordingly.",
  "canvasHost.liveReload":
    "Enables automatic live-reload behavior for canvas assets during development workflows. Keep disabled in production-like environments where deterministic output is preferred.",
  talk: "Talk-mode voice synthesis settings for voice identity, model selection, output format, and interruption behavior. Use this section to tune human-facing voice UX while controlling latency and cost.",
  "talk.voiceId":
    "Primary voice identifier used by talk mode when synthesizing spoken responses. Use a stable voice for consistent persona and switch only when experience goals change.",
  "talk.voiceAliases":
    "Alias map for human-friendly voice shortcuts to concrete voice IDs in talk workflows. Use aliases to simplify operator switching without exposing long provider-native IDs.",
  "talk.modelId":
    "Model override used for talk pipeline generation when voice workflows require different model behavior. Use this when speech output needs a specialized low-latency or style-tuned model.",
  "talk.outputFormat":
    "Audio output format for synthesized talk responses, depending on provider support and client playback expectations. Use formats compatible with your playback channel to avoid decode failures.",
  "talk.interruptOnSpeech":
    "When true, interrupts current speech playback on new speech/input events for more conversational turn-taking. Keep enabled for interactive voice UX and disable for uninterrupted long-form playback.",
  "talk.apiKey":
    "Optional talk-provider API key override used specifically for speech synthesis requests. Use env-backed secrets and set this only when talk traffic must use separate credentials.",
  "gateway.auth.token":
    "Required by default for gateway access (unless using Tailscale Serve identity); required for non-loopback binds.",
  "gateway.auth.password": "Required for Tailscale funnel.",
  "agents.defaults.sandbox.browser.network":
    "Docker network for sandbox browser containers (default: openclaw-sandbox-browser). Avoid bridge if you need stricter isolation.",
  "agents.list[].sandbox.browser.network": "Per-agent override for sandbox browser Docker network.",
  "agents.defaults.sandbox.browser.cdpSourceRange":
    "Optional CIDR allowlist for container-edge CDP ingress (for example 172.21.0.1/32).",
  "agents.list[].sandbox.browser.cdpSourceRange":
    "Per-agent override for CDP source CIDR allowlist.",
  "gateway.controlUi.basePath":
    "Optional URL prefix where the Control UI is served (e.g. /openclaw).",
  "gateway.controlUi.root":
    "Optional filesystem root for Control UI assets (defaults to dist/control-ui).",
  "gateway.controlUi.allowedOrigins":
    "Allowed browser origins for Control UI/WebChat websocket connections (full origins only, e.g. https://control.example.com).",
  "gateway.controlUi.allowInsecureAuth":
    "Loosens strict browser auth checks for Control UI when you must run a non-standard setup. Keep this off unless you trust your network and proxy path, because impersonation risk is higher.",
  "gateway.controlUi.dangerouslyDisableDeviceAuth":
    "Disables Control UI device identity checks and relies on token/password only. Use only for short-lived debugging on trusted networks, then turn it off immediately.",
  "gateway.http.endpoints.chatCompletions.enabled":
    "Enable the OpenAI-compatible `POST /v1/chat/completions` endpoint (default: false).",
  "gateway.reload.mode":
    'Controls how config edits are applied: "off" ignores live edits, "restart" always restarts, "hot" applies in-process, and "hybrid" tries hot then restarts if required. Keep "hybrid" for safest routine updates.',
  "gateway.reload.debounceMs": "Debounce window (ms) before applying config changes.",
  "gateway.nodes.browser.mode":
    'Node browser routing ("auto" = pick single connected browser node, "manual" = require node param, "off" = disable).',
  "gateway.nodes.browser.node": "Pin browser routing to a specific node id or name (optional).",
  "gateway.nodes.allowCommands":
    "Extra node.invoke commands to allow beyond the gateway defaults (array of command strings). Enabling dangerous commands here is a security-sensitive override and is flagged by `openclaw security audit`.",
  "gateway.nodes.denyCommands":
    "Commands to block even if present in node claims or default allowlist.",
  nodeHost:
    "Node host controls for features exposed from this gateway node to other nodes or clients. Keep defaults unless you intentionally proxy local capabilities across your node network.",
  "nodeHost.browserProxy":
    "Groups browser-proxy settings for exposing local browser control through node routing. Enable only when remote node workflows need your local browser profiles.",
  "nodeHost.browserProxy.enabled":
    "Expose the local browser control server through node proxy routing so remote clients can use this host's browser capabilities. Keep disabled unless remote automation explicitly depends on it.",
  "nodeHost.browserProxy.allowProfiles":
    "Optional allowlist of browser profile names exposed through node proxy routing. Leave empty to expose all configured profiles, or use a tight list to enforce least-privilege profile access.",
  media:
    "Top-level media behavior shared across providers and tools that handle inbound files. Keep defaults unless you need stable filenames for external processing pipelines.",
  "media.preserveFilenames":
    "When enabled, uploaded media keeps its original filename instead of a generated temp-safe name. Turn this on when downstream automations depend on stable names, and leave off to reduce accidental filename leakage.",
  audio:
    "Global audio ingestion settings used before higher-level tools process speech or media content. Configure this when you need deterministic transcription behavior for voice notes and clips.",
  "audio.transcription":
    "Command-based transcription settings for converting audio files into text before agent handling. Keep a simple, deterministic command path here so failures are easy to diagnose in logs.",
  "audio.transcription.command":
    'Executable + args used to transcribe audio (first token must be a safe binary/path), for example `["whisper-cli", "--model", "small", "{input}"]`. Prefer a pinned command so runtime environments behave consistently.',
  "audio.transcription.timeoutSeconds":
    "Maximum time allowed for the transcription command to finish before it is aborted. Increase this for longer recordings, and keep it tight in latency-sensitive deployments.",
  bindings:
    "Static routing bindings that pin inbound conversations to specific agent IDs by match rules. Use bindings for deterministic ownership when dynamic routing should not decide.",
  "bindings[].agentId":
    "Target agent ID that receives traffic when the corresponding binding match rule is satisfied. Use valid configured agent IDs only so routing does not fail at runtime.",
  "bindings[].match":
    "Match rule object for deciding when a binding applies, including channel and optional account/peer constraints. Keep rules narrow to avoid accidental agent takeover across contexts.",
  "bindings[].match.channel":
    "Channel/provider identifier this binding applies to, such as `telegram`, `discord`, or a plugin channel ID. Use the configured channel key exactly so binding evaluation works reliably.",
  "bindings[].match.accountId":
    "Optional account selector for multi-account channel setups so the binding applies only to one identity. Use this when account scoping is required for the route and leave unset otherwise.",
  "bindings[].match.peer":
    "Optional peer matcher for specific conversations including peer kind and peer id. Use this when only one direct/group/channel target should be pinned to an agent.",
  "bindings[].match.peer.kind":
    'Peer conversation type: "direct", "group", "channel", or legacy "dm" (deprecated alias for direct). Prefer "direct" for new configs and keep kind aligned with channel semantics.',
  "bindings[].match.peer.id":
    "Conversation identifier used with peer matching, such as a chat ID, channel ID, or group ID from the provider. Keep this exact to avoid silent non-matches.",
  "bindings[].match.guildId":
    "Optional Discord-style guild/server ID constraint for binding evaluation in multi-server deployments. Use this when the same peer identifiers can appear across different guilds.",
  "bindings[].match.teamId":
    "Optional team/workspace ID constraint used by providers that scope chats under teams. Add this when you need bindings isolated to one workspace context.",
  "bindings[].match.roles":
    "Optional role-based filter list used by providers that attach roles to chat context. Use this to route privileged or operational role traffic to specialized agents.",
  broadcast:
    "Broadcast routing map for sending the same outbound message to multiple peer IDs per source conversation. Keep this minimal and audited because one source can fan out to many destinations.",
  "broadcast.strategy":
    'Delivery order for broadcast fan-out: "parallel" sends to all targets concurrently, while "sequential" sends one-by-one. Use "parallel" for speed and "sequential" for stricter ordering/backpressure control.',
  "broadcast.*":
    "Per-source broadcast destination list where each key is a source peer ID and the value is an array of destination peer IDs. Keep lists intentional to avoid accidental message amplification.",
  "diagnostics.flags":
    'Enable targeted diagnostics logs by flag (e.g. ["telegram.http"]). Supports wildcards like "telegram.*" or "*".',
  "diagnostics.enabled":
    "Master toggle for diagnostics instrumentation output in logs and telemetry wiring paths. Keep enabled for normal observability, and disable only in tightly constrained environments.",
  "diagnostics.otel.enabled":
    "Enables OpenTelemetry export pipeline for traces, metrics, and logs based on configured endpoint/protocol settings. Keep disabled unless your collector endpoint and auth are fully configured.",
  "diagnostics.otel.endpoint":
    "Collector endpoint URL used for OpenTelemetry export transport, including scheme and port. Use a reachable, trusted collector endpoint and monitor ingestion errors after rollout.",
  "diagnostics.otel.protocol":
    'OTel transport protocol for telemetry export: "http/protobuf" or "grpc" depending on collector support. Use the protocol your observability backend expects to avoid dropped telemetry payloads.',
  "diagnostics.otel.headers":
    "Additional HTTP/gRPC metadata headers sent with OpenTelemetry export requests, often used for tenant auth or routing. Keep secrets in env-backed values and avoid unnecessary header sprawl.",
  "diagnostics.otel.serviceName":
    "Service name reported in telemetry resource attributes to identify this gateway instance in observability backends. Use stable names so dashboards and alerts remain consistent over deployments.",
  "diagnostics.otel.traces":
    "Enable trace signal export to the configured OpenTelemetry collector endpoint. Keep enabled when latency/debug tracing is needed, and disable if you only want metrics/logs.",
  "diagnostics.otel.metrics":
    "Enable metrics signal export to the configured OpenTelemetry collector endpoint. Keep enabled for runtime health dashboards, and disable only if metric volume must be minimized.",
  "diagnostics.otel.logs":
    "Enable log signal export through OpenTelemetry in addition to local logging sinks. Use this when centralized log correlation is required across services and agents.",
  "diagnostics.otel.sampleRate":
    "Trace sampling rate (0-1) controlling how much trace traffic is exported to observability backends. Lower rates reduce overhead/cost, while higher rates improve debugging fidelity.",
  "diagnostics.otel.flushIntervalMs":
    "Interval in milliseconds for periodic telemetry flush from buffers to the collector. Increase to reduce export chatter, or lower for faster visibility during active incident response.",
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
    "When true (default), backgrounded exec sessions on exit and node exec lifecycle events enqueue a system event and request a heartbeat.",
  "tools.exec.notifyOnExitEmptySuccess":
    "When true, successful backgrounded exec exits with empty output still enqueue a completion system event (default: false).",
  "tools.exec.pathPrepend": "Directories to prepend to PATH for exec runs (gateway/sandbox).",
  "tools.exec.safeBins":
    "Allow stdin-only safe binaries to run without explicit allowlist entries.",
  "tools.exec.safeBinTrustedDirs":
    "Additional explicit directories trusted for safe-bin path checks (PATH entries are never auto-trusted).",
  "tools.exec.safeBinProfiles":
    "Optional per-binary safe-bin profiles (positional limits + allowed/denied flags).",
  "tools.profile":
    "Global tool profile name used to select a predefined tool policy baseline before applying allow/deny overrides. Use this for consistent environment posture across agents and keep profile names stable.",
  "tools.alsoAllow":
    "Extra tool allowlist entries merged on top of the selected tool profile and default policy. Keep this list small and explicit so audits can quickly identify intentional policy exceptions.",
  "tools.byProvider":
    "Per-provider tool allow/deny overrides keyed by channel/provider ID to tailor capabilities by surface. Use this when one provider needs stricter controls than global tool policy.",
  "agents.list[].tools.profile":
    "Per-agent override for tool profile selection when one agent needs a different capability baseline. Use this sparingly so policy differences across agents stay intentional and reviewable.",
  "agents.list[].tools.alsoAllow":
    "Per-agent additive allowlist for tools on top of global and profile policy. Keep narrow to avoid accidental privilege expansion on specialized agents.",
  "agents.list[].tools.byProvider":
    "Per-agent provider-specific tool policy overrides for channel-scoped capability control. Use this when a single agent needs tighter restrictions on one provider than others.",
  "tools.exec.approvalRunningNoticeMs":
    "Delay in milliseconds before showing an in-progress notice after an exec approval is granted. Increase to reduce flicker for fast commands, or lower for quicker operator feedback.",
  "tools.links.enabled":
    "Enable automatic link understanding pre-processing so URLs can be summarized before agent reasoning. Keep enabled for richer context, and disable when strict minimal processing is required.",
  "tools.links.maxLinks":
    "Maximum number of links expanded per turn during link understanding. Use lower values to control latency/cost in chatty threads and higher values when multi-link context is critical.",
  "tools.links.timeoutSeconds":
    "Per-link understanding timeout budget in seconds before unresolved links are skipped. Keep this bounded to avoid long stalls when external sites are slow or unreachable.",
  "tools.links.models":
    "Preferred model list for link understanding tasks, evaluated in order as fallbacks when supported. Use lightweight models first for routine summarization and heavier models only when needed.",
  "tools.links.scope":
    "Controls when link understanding runs relative to conversation context and message type. Keep scope conservative to avoid unnecessary fetches on messages where links are not actionable.",
  "tools.media.models":
    "Shared fallback model list used by media understanding tools when modality-specific model lists are not set. Keep this aligned with available multimodal providers to avoid runtime fallback churn.",
  "tools.media.concurrency":
    "Maximum number of concurrent media understanding operations per turn across image, audio, and video tasks. Lower this in resource-constrained deployments to prevent CPU/network saturation.",
  "tools.media.image.enabled":
    "Enable image understanding so attached or referenced images can be interpreted into textual context. Disable if you need text-only operation or want to avoid image-processing cost.",
  "tools.media.image.maxBytes":
    "Maximum accepted image payload size in bytes before the item is skipped or truncated by policy. Keep limits realistic for your provider caps and infrastructure bandwidth.",
  "tools.media.image.maxChars":
    "Maximum characters returned from image understanding output after model response normalization. Use tighter limits to reduce prompt bloat and larger limits for detail-heavy OCR tasks.",
  "tools.media.image.prompt":
    "Instruction template used for image understanding requests to shape extraction style and detail level. Keep prompts deterministic so outputs stay consistent across turns and channels.",
  "tools.media.image.timeoutSeconds":
    "Timeout in seconds for each image understanding request before it is aborted. Increase for high-resolution analysis and lower it for latency-sensitive operator workflows.",
  "tools.media.image.attachments":
    "Attachment handling policy for image inputs, including which message attachments qualify for image analysis. Use restrictive settings in untrusted channels to reduce unexpected processing.",
  "tools.media.image.models":
    "Ordered model preferences specifically for image understanding when you want to override shared media models. Put the most reliable multimodal model first to reduce fallback attempts.",
  "tools.media.image.scope":
    "Scope selector for when image understanding is attempted (for example only explicit requests versus broader auto-detection). Keep narrow scope in busy channels to control token and API spend.",
  "tools.media.audio.enabled":
    "Enable audio understanding so voice notes or audio clips can be transcribed/summarized for agent context. Disable when audio ingestion is outside policy or unnecessary for your workflows.",
  "tools.media.audio.maxBytes":
    "Maximum accepted audio payload size in bytes before processing is rejected or clipped by policy. Set this based on expected recording length and upstream provider limits.",
  "tools.media.audio.maxChars":
    "Maximum characters retained from audio understanding output to prevent oversized transcript injection. Increase for long-form dictation, or lower to keep conversational turns compact.",
  "tools.media.audio.prompt":
    "Instruction template guiding audio understanding output style, such as concise summary versus near-verbatim transcript. Keep wording consistent so downstream automations can rely on output format.",
  "tools.media.audio.timeoutSeconds":
    "Timeout in seconds for audio understanding execution before the operation is cancelled. Use longer timeouts for long recordings and tighter ones for interactive chat responsiveness.",
  "tools.media.audio.language":
    "Preferred language hint for audio understanding/transcription when provider support is available. Set this to improve recognition accuracy for known primary languages.",
  "tools.media.audio.attachments":
    "Attachment policy for audio inputs indicating which uploaded files are eligible for audio processing. Keep restrictive defaults in mixed-content channels to avoid unintended audio workloads.",
  "tools.media.audio.models":
    "Ordered model preferences specifically for audio understanding, used before shared media model fallback. Choose models optimized for transcription quality in your primary language/domain.",
  "tools.media.audio.scope":
    "Scope selector for when audio understanding runs across inbound messages and attachments. Keep focused scopes in high-volume channels to reduce cost and avoid accidental transcription.",
  "tools.media.video.enabled":
    "Enable video understanding so clips can be summarized into text for downstream reasoning and responses. Disable when processing video is out of policy or too expensive for your deployment.",
  "tools.media.video.maxBytes":
    "Maximum accepted video payload size in bytes before policy rejection or trimming occurs. Tune this to provider and infrastructure limits to avoid repeated timeout/failure loops.",
  "tools.media.video.maxChars":
    "Maximum characters retained from video understanding output to control prompt growth. Raise for dense scene descriptions and lower when concise summaries are preferred.",
  "tools.media.video.prompt":
    "Instruction template for video understanding describing desired summary granularity and focus areas. Keep this stable so output quality remains predictable across model/provider fallbacks.",
  "tools.media.video.timeoutSeconds":
    "Timeout in seconds for each video understanding request before cancellation. Use conservative values in interactive channels and longer values for offline or batch-heavy processing.",
  "tools.media.video.attachments":
    "Attachment eligibility policy for video analysis, defining which message files can trigger video processing. Keep this explicit in shared channels to prevent accidental large media workloads.",
  "tools.media.video.models":
    "Ordered model preferences specifically for video understanding before shared media fallback applies. Prioritize models with strong multimodal video support to minimize degraded summaries.",
  "tools.media.video.scope":
    "Scope selector controlling when video understanding is attempted across incoming events. Narrow scope in noisy channels, and broaden only where video interpretation is core to workflow.",
  "skills.load.watch":
    "Enable filesystem watching for skill-definition changes so updates can be applied without full process restart. Keep enabled in development workflows and disable in immutable production images.",
  "skills.load.watchDebounceMs":
    "Debounce window in milliseconds for coalescing rapid skill file changes before reload logic runs. Increase to reduce reload churn on frequent writes, or lower for faster edit feedback.",
  approvals:
    "Approval routing controls for forwarding exec approval requests to chat destinations outside the originating session. Keep this disabled unless operators need explicit out-of-band approval visibility.",
  "approvals.exec":
    "Groups exec-approval forwarding behavior including enablement, routing mode, filters, and explicit targets. Configure here when approval prompts must reach operational channels instead of only the origin thread.",
  "approvals.exec.enabled":
    "Enables forwarding of exec approval requests to configured delivery destinations (default: false). Keep disabled in low-risk setups and enable only when human approval responders need channel-visible prompts.",
  "approvals.exec.mode":
    'Controls where approval prompts are sent: "session" uses origin chat, "targets" uses configured targets, and "both" sends to both paths. Use "session" as baseline and expand only when operational workflow requires redundancy.',
  "approvals.exec.agentFilter":
    'Optional allowlist of agent IDs eligible for forwarded approvals, for example `["primary", "ops-agent"]`. Use this to limit forwarding blast radius and avoid notifying channels for unrelated agents.',
  "approvals.exec.sessionFilter":
    'Optional session-key filters matched as substring or regex-style patterns, for example `["discord:", "^agent:ops:"]`. Use narrow patterns so only intended approval contexts are forwarded to shared destinations.',
  "approvals.exec.targets":
    "Explicit delivery targets used when forwarding mode includes targets, each with channel and destination details. Keep target lists least-privilege and validate each destination before enabling broad forwarding.",
  "approvals.exec.targets[].channel":
    "Channel/provider ID used for forwarded approval delivery, such as discord, slack, or a plugin channel id. Use valid channel IDs only so approvals do not silently fail due to unknown routes.",
  "approvals.exec.targets[].to":
    "Destination identifier inside the target channel (channel ID, user ID, or thread root depending on provider). Verify semantics per provider because destination format differs across channel integrations.",
  "approvals.exec.targets[].accountId":
    "Optional account selector for multi-account channel setups when approvals must route through a specific account context. Use this only when the target channel has multiple configured identities.",
  "approvals.exec.targets[].threadId":
    "Optional thread/topic target for channels that support threaded delivery of forwarded approvals. Use this to keep approval traffic contained in operational threads instead of main channels.",
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
  "tools.web.search.provider":
    'Search provider ("brave", "perplexity", "grok", "gemini", or "kimi"). Auto-detected from available API keys if omitted.',
  "tools.web.search.apiKey": "Brave Search API key (fallback: BRAVE_API_KEY env var).",
  "tools.web.search.maxResults": "Default number of results to return (1-10).",
  "tools.web.search.timeoutSeconds": "Timeout in seconds for web_search requests.",
  "tools.web.search.cacheTtlMinutes": "Cache TTL in minutes for web_search results.",
  "tools.web.search.gemini.apiKey":
    "Gemini API key for Google Search grounding (fallback: GEMINI_API_KEY env var).",
  "tools.web.search.gemini.model": 'Gemini model override (default: "gemini-2.5-flash").',
  "tools.web.search.grok.apiKey": "Grok (xAI) API key (fallback: XAI_API_KEY env var).",
  "tools.web.search.grok.model": 'Grok model override (default: "grok-4-1-fast").',
  "tools.web.search.kimi.apiKey":
    "Moonshot/Kimi API key (fallback: KIMI_API_KEY or MOONSHOT_API_KEY env var).",
  "tools.web.search.kimi.baseUrl":
    'Kimi base URL override (default: "https://api.moonshot.ai/v1").',
  "tools.web.search.kimi.model": 'Kimi model override (default: "moonshot-v1-128k").',
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
  models:
    "Model catalog root for provider definitions, merge/replace behavior, and optional Bedrock discovery integration. Keep provider definitions explicit and validated before relying on production failover paths.",
  "models.mode":
    'Controls provider catalog behavior: "merge" keeps built-ins and overlays your custom providers, while "replace" uses only your configured providers. Keep "merge" unless you intentionally want a strict custom list.',
  "models.providers":
    "Provider map keyed by provider ID containing connection/auth settings and concrete model definitions. Use stable provider keys so references from agents and tooling remain portable across environments.",
  "models.providers.*.baseUrl":
    "Base URL for the provider endpoint used to serve model requests for that provider entry. Use HTTPS endpoints and keep URLs environment-specific through config templating where needed.",
  "models.providers.*.apiKey":
    "Provider credential used for API-key based authentication when the provider requires direct key auth. Use secret/env substitution and avoid storing real keys in committed config files.",
  "models.providers.*.auth":
    'Selects provider auth style: "api-key" for API key auth, "token" for bearer token auth, "oauth" for OAuth credentials, and "aws-sdk" for AWS credential resolution. Match this to your provider requirements.',
  "models.providers.*.api":
    "Provider API adapter selection controlling request/response compatibility handling for model calls. Use the adapter that matches your upstream provider protocol to avoid feature mismatch.",
  "models.providers.*.headers":
    "Static HTTP headers merged into provider requests for tenant routing, proxy auth, or custom gateway requirements. Use this sparingly and keep sensitive header values in secrets.",
  "models.providers.*.authHeader":
    "When true, credentials are sent via the HTTP Authorization header even if alternate auth is possible. Use this only when your provider or proxy explicitly requires Authorization forwarding.",
  "models.providers.*.models":
    "Declared model list for a provider including identifiers, metadata, and optional compatibility/cost hints. Keep IDs exact to provider catalog values so selection and fallback resolve correctly.",
  "models.bedrockDiscovery":
    "Automatic AWS Bedrock model discovery settings used to synthesize provider model entries from account visibility. Keep discovery scoped and refresh intervals conservative to reduce API churn.",
  "models.bedrockDiscovery.enabled":
    "Enables periodic Bedrock model discovery and catalog refresh for Bedrock-backed providers. Keep disabled unless Bedrock is actively used and IAM permissions are correctly configured.",
  "models.bedrockDiscovery.region":
    "AWS region used for Bedrock discovery calls when discovery is enabled for your deployment. Use the region where your Bedrock models are provisioned to avoid empty discovery results.",
  "models.bedrockDiscovery.providerFilter":
    "Optional provider allowlist filter for Bedrock discovery so only selected providers are refreshed. Use this to limit discovery scope in multi-provider environments.",
  "models.bedrockDiscovery.refreshInterval":
    "Refresh cadence for Bedrock discovery polling in seconds to detect newly available models over time. Use longer intervals in production to reduce API cost and control-plane noise.",
  "models.bedrockDiscovery.defaultContextWindow":
    "Fallback context-window value applied to discovered models when provider metadata lacks explicit limits. Use realistic defaults to avoid oversized prompts that exceed true provider constraints.",
  "models.bedrockDiscovery.defaultMaxTokens":
    "Fallback max-token value applied to discovered models without explicit output token limits. Use conservative defaults to reduce truncation surprises and unexpected token spend.",
  auth: "Authentication profile root used for multi-profile provider credentials and cooldown-based failover ordering. Keep profiles minimal and explicit so automatic failover behavior stays auditable.",
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
  "auth.cooldowns":
    "Cooldown/backoff controls for temporary profile suppression after billing-related failures and retry windows. Use these to prevent rapid re-selection of profiles that are still blocked.",
  "auth.cooldowns.billingBackoffHours":
    "Base backoff (hours) when a profile fails due to billing/insufficient credits (default: 5).",
  "auth.cooldowns.billingBackoffHoursByProvider":
    "Optional per-provider overrides for billing backoff (hours).",
  "auth.cooldowns.billingMaxHours": "Cap (hours) for billing backoff (default: 24).",
  "auth.cooldowns.failureWindowHours": "Failure window (hours) for backoff counters (default: 24).",
  "agents.defaults.workspace":
    "Default workspace path exposed to agent runtime tools for filesystem context and repo-aware behavior. Set this explicitly when running from wrappers so path resolution stays deterministic.",
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
  "agents.defaults.memorySearch.enabled":
    "Master toggle for memory search indexing and retrieval behavior on this agent profile. Keep enabled for semantic recall, and disable when you want fully stateless responses.",
  "agents.defaults.memorySearch.sources":
    'Chooses which sources are indexed: "memory" reads MEMORY.md + memory files, and "sessions" includes transcript history. Keep ["memory"] unless you need recall from prior chat transcripts.',
  "agents.defaults.memorySearch.extraPaths":
    "Adds extra directories or .md files to the memory index beyond default memory files. Use this when key reference docs live elsewhere in your repo; keep paths small and intentional to avoid noisy recall.",
  "agents.defaults.memorySearch.experimental.sessionMemory":
    "Indexes session transcripts into memory search so responses can reference prior chat turns. Keep this off unless transcript recall is needed, because indexing cost and storage usage both increase.",
  "agents.defaults.memorySearch.provider":
    'Selects the embedding backend used to build/query memory vectors: "openai", "gemini", "voyage", "mistral", or "local". Keep your most reliable provider here and configure fallback for resilience.',
  "agents.defaults.memorySearch.model":
    "Embedding model override used by the selected memory provider when a non-default model is required. Set this only when you need explicit recall quality/cost tuning beyond provider defaults.",
  "agents.defaults.memorySearch.remote.baseUrl":
    "Overrides the embedding API endpoint, such as an OpenAI-compatible proxy or custom Gemini base URL. Use this only when routing through your own gateway or vendor endpoint; keep provider defaults otherwise.",
  "agents.defaults.memorySearch.remote.apiKey":
    "Supplies a dedicated API key for remote embedding calls used by memory indexing and query-time embeddings. Use this when memory embeddings should use different credentials than global defaults or environment variables.",
  "agents.defaults.memorySearch.remote.headers":
    "Adds custom HTTP headers to remote embedding requests, merged with provider defaults. Use this for proxy auth and tenant routing headers, and keep values minimal to avoid leaking sensitive metadata.",
  "agents.defaults.memorySearch.remote.batch.enabled":
    "Enables provider batch APIs for embedding jobs when supported (OpenAI/Gemini), improving throughput on larger index runs. Keep this enabled unless debugging provider batch failures or running very small workloads.",
  "agents.defaults.memorySearch.remote.batch.wait":
    "Waits for batch embedding jobs to fully finish before the indexing operation completes. Keep this enabled for deterministic indexing state; disable only if you accept delayed consistency.",
  "agents.defaults.memorySearch.remote.batch.concurrency":
    "Limits how many embedding batch jobs run at the same time during indexing (default: 2). Increase carefully for faster bulk indexing, but watch provider rate limits and queue errors.",
  "agents.defaults.memorySearch.remote.batch.pollIntervalMs":
    "Controls how often the system polls provider APIs for batch job status in milliseconds (default: 2000). Use longer intervals to reduce API chatter, or shorter intervals for faster completion detection.",
  "agents.defaults.memorySearch.remote.batch.timeoutMinutes":
    "Sets the maximum wait time for a full embedding batch operation in minutes (default: 60). Increase for very large corpora or slower providers, and lower it to fail fast in automation-heavy flows.",
  "agents.defaults.memorySearch.local.modelPath":
    "Specifies the local embedding model source for local memory search, such as a GGUF file path or `hf:` URI. Use this only when provider is `local`, and verify model compatibility before large index rebuilds.",
  "agents.defaults.memorySearch.fallback":
    'Backup provider used when primary embeddings fail: "openai", "gemini", "voyage", "mistral", "local", or "none". Set a real fallback for production reliability; use "none" only if you prefer explicit failures.',
  "agents.defaults.memorySearch.store.path":
    "Sets where the SQLite memory index is stored on disk for each agent. Keep the default `~/.openclaw/memory/{agentId}.sqlite` unless you need custom storage placement or backup policy alignment.",
  "agents.defaults.memorySearch.store.vector.enabled":
    "Enables the sqlite-vec extension used for vector similarity queries in memory search (default: true). Keep this enabled for normal semantic recall; disable only for debugging or fallback-only operation.",
  "agents.defaults.memorySearch.store.vector.extensionPath":
    "Overrides the auto-discovered sqlite-vec extension library path (`.dylib`, `.so`, or `.dll`). Use this when your runtime cannot find sqlite-vec automatically or you pin a known-good build.",
  "agents.defaults.memorySearch.chunking.tokens":
    "Chunk size in tokens used when splitting memory sources before embedding/indexing. Increase for broader context per chunk, or lower to improve precision on pinpoint lookups.",
  "agents.defaults.memorySearch.chunking.overlap":
    "Token overlap between adjacent memory chunks to preserve context continuity near split boundaries. Use modest overlap to reduce boundary misses without inflating index size too aggressively.",
  "agents.defaults.memorySearch.query.maxResults":
    "Maximum number of memory hits returned from search before downstream reranking and prompt injection. Raise for broader recall, or lower for tighter prompts and faster responses.",
  "agents.defaults.memorySearch.query.minScore":
    "Minimum relevance score threshold for including memory results in final recall output. Increase to reduce weak/noisy matches, or lower when you need more permissive retrieval.",
  "agents.defaults.memorySearch.query.hybrid.enabled":
    "Combines BM25 keyword matching with vector similarity for better recall on mixed exact + semantic queries. Keep enabled unless you are isolating ranking behavior for troubleshooting.",
  "agents.defaults.memorySearch.query.hybrid.vectorWeight":
    "Controls how strongly semantic similarity influences hybrid ranking (0-1). Increase when paraphrase matching matters more than exact terms; decrease for stricter keyword emphasis.",
  "agents.defaults.memorySearch.query.hybrid.textWeight":
    "Controls how strongly BM25 keyword relevance influences hybrid ranking (0-1). Increase for exact-term matching; decrease when semantic matches should rank higher.",
  "agents.defaults.memorySearch.query.hybrid.candidateMultiplier":
    "Expands the candidate pool before reranking (default: 4). Raise this for better recall on noisy corpora, but expect more compute and slightly slower searches.",
  "agents.defaults.memorySearch.query.hybrid.mmr.enabled":
    "Adds MMR reranking to diversify results and reduce near-duplicate snippets in a single answer window. Enable when recall looks repetitive; keep off for strict score ordering.",
  "agents.defaults.memorySearch.query.hybrid.mmr.lambda":
    "Sets MMR relevance-vs-diversity balance (0 = most diverse, 1 = most relevant, default: 0.7). Lower values reduce repetition; higher values keep tightly relevant but may duplicate.",
  "agents.defaults.memorySearch.query.hybrid.temporalDecay.enabled":
    "Applies recency decay so newer memory can outrank older memory when scores are close. Enable when timeliness matters; keep off for timeless reference knowledge.",
  "agents.defaults.memorySearch.query.hybrid.temporalDecay.halfLifeDays":
    "Controls how fast older memory loses rank when temporal decay is enabled (half-life in days, default: 30). Lower values prioritize recent context more aggressively.",
  "agents.defaults.memorySearch.cache.enabled":
    "Caches computed chunk embeddings in SQLite so reindexing and incremental updates run faster (default: true). Keep this enabled unless investigating cache correctness or minimizing disk usage.",
  memory: "Memory backend configuration (global).",
  "memory.backend":
    'Selects the global memory engine: "builtin" uses OpenClaw memory internals, while "qmd" uses the QMD sidecar pipeline. Keep "builtin" unless you intentionally operate QMD.',
  "memory.citations":
    'Controls citation visibility in replies: "auto" shows citations when useful, "on" always shows them, and "off" hides them. Keep "auto" for a balanced signal-to-noise default.',
  "memory.qmd.command":
    "Sets the executable path for the `qmd` binary used by the QMD backend (default: resolved from PATH). Use an explicit absolute path when multiple qmd installs exist or PATH differs across environments.",
  "memory.qmd.mcporter":
    "Routes QMD work through mcporter (MCP runtime) instead of spawning `qmd` for each call. Use this when cold starts are expensive on large models; keep direct process mode for simpler local setups.",
  "memory.qmd.mcporter.enabled":
    "Routes QMD through an mcporter daemon instead of spawning qmd per request, reducing cold-start overhead for larger models. Keep disabled unless mcporter is installed and configured.",
  "memory.qmd.mcporter.serverName":
    "Names the mcporter server target used for QMD calls (default: qmd). Change only when your mcporter setup uses a custom server name for qmd mcp keep-alive.",
  "memory.qmd.mcporter.startDaemon":
    "Automatically starts the mcporter daemon when mcporter-backed QMD mode is enabled (default: true). Keep enabled unless process lifecycle is managed externally by your service supervisor.",
  "memory.qmd.searchMode":
    'Selects the QMD retrieval path: "query" uses standard query flow, "search" uses search-oriented retrieval, and "vsearch" emphasizes vector retrieval. Keep default unless tuning relevance quality.',
  "memory.qmd.includeDefaultMemory":
    "Automatically indexes default memory files (MEMORY.md and memory/**/*.md) into QMD collections. Keep enabled unless you want indexing controlled only through explicit custom paths.",
  "memory.qmd.paths":
    "Adds custom directories or files to include in QMD indexing, each with an optional name and glob pattern. Use this for project-specific knowledge locations that are outside default memory paths.",
  "memory.qmd.paths.path":
    "Defines the root location QMD should scan, using an absolute path or `~`-relative path. Use stable directories so collection identity does not drift across environments.",
  "memory.qmd.paths.pattern":
    "Filters files under each indexed root using a glob pattern, with default `**/*.md`. Use narrower patterns to reduce noise and indexing cost when directories contain mixed file types.",
  "memory.qmd.paths.name":
    "Sets a stable collection name for an indexed path instead of deriving it from filesystem location. Use this when paths vary across machines but you want consistent collection identity.",
  "memory.qmd.sessions.enabled":
    "Indexes session transcripts into QMD so recall can include prior conversation content (experimental, default: false). Enable only when transcript memory is required and you accept larger index churn.",
  "memory.qmd.sessions.exportDir":
    "Overrides where sanitized session exports are written before QMD indexing. Use this when default state storage is constrained or when exports must land on a managed volume.",
  "memory.qmd.sessions.retentionDays":
    "Defines how long exported session files are kept before automatic pruning, in days (default: unlimited). Set a finite value for storage hygiene or compliance retention policies.",
  "memory.qmd.update.interval":
    "Sets how often QMD refreshes indexes from source content (duration string, default: 5m). Shorter intervals improve freshness but increase background CPU and I/O.",
  "memory.qmd.update.debounceMs":
    "Sets the minimum delay between consecutive QMD refresh attempts in milliseconds (default: 15000). Increase this if frequent file changes cause update thrash or unnecessary background load.",
  "memory.qmd.update.onBoot":
    "Runs an initial QMD update once during gateway startup (default: true). Keep enabled so recall starts from a fresh baseline; disable only when startup speed is more important than immediate freshness.",
  "memory.qmd.update.waitForBootSync":
    "Blocks startup completion until the initial boot-time QMD sync finishes (default: false). Enable when you need fully up-to-date recall before serving traffic, and keep off for faster boot.",
  "memory.qmd.update.embedInterval":
    "Sets how often QMD recomputes embeddings (duration string, default: 60m; set 0 to disable periodic embeds). Lower intervals improve freshness but increase embedding workload and cost.",
  "memory.qmd.update.commandTimeoutMs":
    "Sets timeout for QMD maintenance commands such as collection list/add in milliseconds (default: 30000). Increase when running on slower disks or remote filesystems that delay command completion.",
  "memory.qmd.update.updateTimeoutMs":
    "Sets maximum runtime for each `qmd update` cycle in milliseconds (default: 120000). Raise this for larger collections; lower it when you want quicker failure detection in automation.",
  "memory.qmd.update.embedTimeoutMs":
    "Sets maximum runtime for each `qmd embed` cycle in milliseconds (default: 120000). Increase for heavier embedding workloads or slower hardware, and lower to fail fast under tight SLAs.",
  "memory.qmd.limits.maxResults":
    "Limits how many QMD hits are returned into the agent loop for each recall request (default: 6). Increase for broader recall context, or lower to keep prompts tighter and faster.",
  "memory.qmd.limits.maxSnippetChars":
    "Caps per-result snippet length extracted from QMD hits in characters (default: 700). Lower this when prompts bloat quickly, and raise only if answers consistently miss key details.",
  "memory.qmd.limits.maxInjectedChars":
    "Caps how much QMD text can be injected into one turn across all hits. Use lower values to control prompt bloat and latency; raise only when context is consistently truncated.",
  "memory.qmd.limits.timeoutMs":
    "Sets per-query QMD search timeout in milliseconds (default: 4000). Increase for larger indexes or slower environments, and lower to keep request latency bounded.",
  "memory.qmd.scope":
    "Defines which sessions/channels are eligible for QMD recall using session.sendPolicy-style rules. Keep default direct-only scope unless you intentionally want cross-chat memory sharing.",
  "agents.defaults.memorySearch.cache.maxEntries":
    "Sets a best-effort upper bound on cached embeddings kept in SQLite for memory search. Use this when controlling disk growth matters more than peak reindex speed.",
  "agents.defaults.memorySearch.sync.onSessionStart":
    "Triggers a memory index sync when a session starts so early turns see fresh memory content. Keep enabled when startup freshness matters more than initial turn latency.",
  "agents.defaults.memorySearch.sync.onSearch":
    "Uses lazy sync by scheduling reindex on search after content changes are detected. Keep enabled for lower idle overhead, or disable if you require pre-synced indexes before any query.",
  "agents.defaults.memorySearch.sync.watch":
    "Watches memory files and schedules index updates from file-change events (chokidar). Enable for near-real-time freshness; disable on very large workspaces if watch churn is too noisy.",
  "agents.defaults.memorySearch.sync.watchDebounceMs":
    "Debounce window in milliseconds for coalescing rapid file-watch events before reindex runs. Increase to reduce churn on frequently-written files, or lower for faster freshness.",
  "agents.defaults.memorySearch.sync.sessions.deltaBytes":
    "Requires at least this many newly appended bytes before session transcript changes trigger reindex (default: 100000). Increase to reduce frequent small reindexes, or lower for faster transcript freshness.",
  "agents.defaults.memorySearch.sync.sessions.deltaMessages":
    "Requires at least this many appended transcript messages before reindex is triggered (default: 50). Lower this for near-real-time transcript recall, or raise it to reduce indexing churn.",
  ui: "UI presentation settings for accenting and assistant identity shown in control surfaces. Use this for branding and readability customization without changing runtime behavior.",
  "ui.seamColor":
    "Primary accent/seam color used by UI surfaces for emphasis, badges, and visual identity cues. Use high-contrast values that remain readable across light/dark themes.",
  "ui.assistant":
    "Assistant display identity settings for name and avatar shown in UI surfaces. Keep these values aligned with your operator-facing persona and support expectations.",
  "ui.assistant.name":
    "Display name shown for the assistant in UI views, chat chrome, and status contexts. Keep this stable so operators can reliably identify which assistant persona is active.",
  "ui.assistant.avatar":
    "Assistant avatar image source used in UI surfaces (URL, path, or data URI depending on runtime support). Use trusted assets and consistent branding dimensions for clean rendering.",
  plugins:
    "Plugin system controls for enabling extensions, constraining load scope, configuring entries, and tracking installs. Keep plugin policy explicit and least-privilege in production environments.",
  "plugins.enabled":
    "Enable or disable plugin/extension loading globally during startup and config reload (default: true). Keep enabled only when extension capabilities are required by your deployment.",
  "plugins.allow":
    "Optional allowlist of plugin IDs; when set, only listed plugins are eligible to load. Use this to enforce approved extension inventories in controlled environments.",
  "plugins.deny":
    "Optional denylist of plugin IDs that are blocked even if allowlists or paths include them. Use deny rules for emergency rollback and hard blocks on risky plugins.",
  "plugins.load":
    "Plugin loader configuration group for specifying filesystem paths where plugins are discovered. Keep load paths explicit and reviewed to avoid accidental untrusted extension loading.",
  "plugins.load.paths":
    "Additional plugin files or directories scanned by the loader beyond built-in defaults. Use dedicated extension directories and avoid broad paths with unrelated executable content.",
  "plugins.slots":
    "Selects which plugins own exclusive runtime slots such as memory so only one plugin provides that capability. Use explicit slot ownership to avoid overlapping providers with conflicting behavior.",
  "plugins.slots.memory":
    'Select the active memory plugin by id, or "none" to disable memory plugins.',
  "plugins.entries":
    "Per-plugin settings keyed by plugin ID including enablement and plugin-specific runtime configuration payloads. Use this for scoped plugin tuning without changing global loader policy.",
  "plugins.entries.*.enabled":
    "Per-plugin enablement override for a specific entry, applied on top of global plugin policy (restart required). Use this to stage plugin rollout gradually across environments.",
  "plugins.entries.*.apiKey":
    "Optional API key field consumed by plugins that accept direct key configuration in entry settings. Use secret/env substitution and avoid committing real credentials into config files.",
  "plugins.entries.*.env":
    "Per-plugin environment variable map injected for that plugin runtime context only. Use this to scope provider credentials to one plugin instead of sharing global process environment.",
  "plugins.entries.*.config":
    "Plugin-defined configuration payload interpreted by that plugin's own schema and validation rules. Use only documented fields from the plugin to prevent ignored or invalid settings.",
  "plugins.installs":
    "CLI-managed install metadata (used by `openclaw plugins update` to locate install sources).",
  "plugins.installs.*.source": 'Install source ("npm", "archive", or "path").',
  "plugins.installs.*.spec": "Original npm spec used for install (if source is npm).",
  "plugins.installs.*.sourcePath": "Original archive/path used for install (if any).",
  "plugins.installs.*.installPath":
    "Resolved install directory (usually ~/.openclaw/extensions/<id>).",
  "plugins.installs.*.version": "Version recorded at install time (if available).",
  "plugins.installs.*.resolvedName": "Resolved npm package name from the fetched artifact.",
  "plugins.installs.*.resolvedVersion":
    "Resolved npm package version from the fetched artifact (useful for non-pinned specs).",
  "plugins.installs.*.resolvedSpec":
    "Resolved exact npm spec (<name>@<version>) from the fetched artifact.",
  "plugins.installs.*.integrity":
    "Resolved npm dist integrity hash for the fetched artifact (if reported by npm).",
  "plugins.installs.*.shasum":
    "Resolved npm dist shasum for the fetched artifact (if reported by npm).",
  "plugins.installs.*.resolvedAt":
    "ISO timestamp when npm package metadata was last resolved for this install record.",
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
  "agents.defaults.compaction":
    "Compaction tuning for when context nears token limits, including history share, reserve headroom, and pre-compaction memory flush behavior. Use this when long-running sessions need stable continuity under tight context windows.",
  "agents.defaults.compaction.mode":
    'Compaction strategy mode: "default" uses baseline behavior, while "safeguard" applies stricter guardrails to preserve recent context. Keep "default" unless you observe aggressive history loss near limit boundaries.',
  "agents.defaults.compaction.reserveTokens":
    "Token headroom reserved for reply generation and tool output after compaction runs. Use higher reserves for verbose/tool-heavy sessions, and lower reserves when maximizing retained history matters more.",
  "agents.defaults.compaction.keepRecentTokens":
    "Minimum token budget preserved from the most recent conversation window during compaction. Use higher values to protect immediate context continuity and lower values to keep more long-tail history.",
  "agents.defaults.compaction.reserveTokensFloor":
    "Minimum floor enforced for reserveTokens in Pi compaction paths (0 disables the floor guard). Use a non-zero floor to avoid over-aggressive compression under fluctuating token estimates.",
  "agents.defaults.compaction.maxHistoryShare":
    "Maximum fraction of total context budget allowed for retained history after compaction (range 0.1-0.9). Use lower shares for more generation headroom or higher shares for deeper historical continuity.",
  "agents.defaults.compaction.memoryFlush":
    "Pre-compaction memory flush settings that run an agentic memory write before heavy compaction. Keep enabled for long sessions so salient context is persisted before aggressive trimming.",
  "agents.defaults.compaction.memoryFlush.enabled":
    "Enables pre-compaction memory flush before the runtime performs stronger history reduction near token limits. Keep enabled unless you intentionally disable memory side effects in constrained environments.",
  "agents.defaults.compaction.memoryFlush.softThresholdTokens":
    "Threshold distance to compaction (in tokens) that triggers pre-compaction memory flush execution. Use earlier thresholds for safer persistence, or tighter thresholds for lower flush frequency.",
  "agents.defaults.compaction.memoryFlush.prompt":
    "User-prompt template used for the pre-compaction memory flush turn when generating memory candidates. Use this only when you need custom extraction instructions beyond the default memory flush behavior.",
  "agents.defaults.compaction.memoryFlush.systemPrompt":
    "System-prompt override for the pre-compaction memory flush turn to control extraction style and safety constraints. Use carefully so custom instructions do not reduce memory quality or leak sensitive context.",
  "agents.defaults.humanDelay.mode": 'Delay style for block replies ("off", "natural", "custom").',
  "agents.defaults.humanDelay.minMs": "Minimum delay in ms for custom humanDelay (default: 800).",
  "agents.defaults.humanDelay.maxMs": "Maximum delay in ms for custom humanDelay (default: 2500).",
  commands:
    "Controls chat command surfaces, owner gating, and elevated command access behavior across providers. Keep defaults unless you need stricter operator controls or broader command availability.",
  "commands.native":
    "Registers native slash/menu commands with channels that support command registration (Discord, Slack, Telegram). Keep enabled for discoverability unless you intentionally run text-only command workflows.",
  "commands.nativeSkills":
    "Registers native skill commands so users can invoke skills directly from provider command menus where supported. Keep aligned with your skill policy so exposed commands match what operators expect.",
  "commands.text":
    "Enables text-command parsing in chat input in addition to native command surfaces where available. Keep this enabled for compatibility across channels that do not support native command registration.",
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
  "commands.ownerDisplay":
    "Controls how owner IDs are rendered in the system prompt. Allowed values: raw, hash. Default: raw.",
  "commands.ownerDisplaySecret":
    "Optional secret used to HMAC hash owner IDs when ownerDisplay=hash. Prefer env substitution.",
  "commands.allowFrom":
    "Defines elevated command allow rules by channel and sender for owner-level command surfaces. Use narrow provider-specific identities so privileged commands are not exposed to broad chat audiences.",
  session:
    "Global session routing, reset, delivery policy, and maintenance controls for conversation history behavior. Keep defaults unless you need stricter isolation, retention, or delivery constraints.",
  "session.scope":
    'Sets base session grouping strategy: "per-sender" isolates by sender and "global" shares one session per channel context. Keep "per-sender" for safer multi-user behavior unless deliberate shared context is required.',
  "session.dmScope":
    'DM session scoping: "main" keeps continuity, while "per-peer", "per-channel-peer", and "per-account-channel-peer" increase isolation. Use isolated modes for shared inboxes or multi-account deployments.',
  "session.identityLinks":
    "Maps canonical identities to provider-prefixed peer IDs so equivalent users resolve to one DM thread (example: telegram:123456). Use this when the same human appears across multiple channels or accounts.",
  "session.resetTriggers":
    "Lists message triggers that force a session reset when matched in inbound content. Use sparingly for explicit reset phrases so context is not dropped unexpectedly during normal conversation.",
  "session.idleMinutes":
    "Applies a legacy idle reset window in minutes for session reuse behavior across inactivity gaps. Use this only for compatibility and prefer structured reset policies under session.reset/session.resetByType.",
  "session.reset":
    "Defines the default reset policy object used when no type-specific or channel-specific override applies. Set this first, then layer resetByType or resetByChannel only where behavior must differ.",
  "session.reset.mode":
    'Selects reset strategy: "daily" resets at a configured hour and "idle" resets after inactivity windows. Keep one clear mode per policy to avoid surprising context turnover patterns.',
  "session.reset.atHour":
    "Sets local-hour boundary (0-23) for daily reset mode so sessions roll over at predictable times. Use with mode=daily and align to operator timezone expectations for human-readable behavior.",
  "session.reset.idleMinutes":
    "Sets inactivity window before reset for idle mode and can also act as secondary guard with daily mode. Use larger values to preserve continuity or smaller values for fresher short-lived threads.",
  "session.resetByType":
    "Overrides reset behavior by chat type (direct, group, thread) when defaults are not sufficient. Use this when group/thread traffic needs different reset cadence than direct messages.",
  "session.resetByType.direct":
    "Defines reset policy for direct chats and supersedes the base session.reset configuration for that type. Use this as the canonical direct-message override instead of the legacy dm alias.",
  "session.resetByType.dm":
    "Deprecated alias for direct reset behavior kept for backward compatibility with older configs. Use session.resetByType.direct instead so future tooling and validation remain consistent.",
  "session.resetByType.group":
    "Defines reset policy for group chat sessions where continuity and noise patterns differ from DMs. Use shorter idle windows for busy groups if context drift becomes a problem.",
  "session.resetByType.thread":
    "Defines reset policy for thread-scoped sessions, including focused channel thread workflows. Use this when thread sessions should expire faster or slower than other chat types.",
  "session.resetByChannel":
    "Provides channel-specific reset overrides keyed by provider/channel id for fine-grained behavior control. Use this only when one channel needs exceptional reset behavior beyond type-level policies.",
  "session.store":
    "Sets the session storage file path used to persist session records across restarts. Use an explicit path only when you need custom disk layout, backup routing, or mounted-volume storage.",
  "session.typingIntervalSeconds":
    "Controls interval for repeated typing indicators while replies are being prepared in typing-capable channels. Increase to reduce chatty updates or decrease for more active typing feedback.",
  "session.typingMode":
    'Controls typing behavior timing: "never", "instant", "thinking", or "message" based emission points. Keep conservative modes in high-volume channels to avoid unnecessary typing noise.',
  "session.mainKey":
    'Overrides the canonical main session key used for continuity when dmScope or routing logic points to "main". Use a stable value only if you intentionally need custom session anchoring.',
  "session.sendPolicy":
    "Controls cross-session send permissions using allow/deny rules evaluated against channel, chatType, and key prefixes. Use this to fence where session tools can deliver messages in complex environments.",
  "session.sendPolicy.default":
    'Sets fallback action when no sendPolicy rule matches: "allow" or "deny". Keep "allow" for simpler setups, or choose "deny" when you require explicit allow rules for every destination.',
  "session.sendPolicy.rules":
    'Ordered allow/deny rules evaluated before the default action, for example `{ action: "deny", match: { channel: "discord" } }`. Put most specific rules first so broad rules do not shadow exceptions.',
  "session.sendPolicy.rules[].action":
    'Defines rule decision as "allow" or "deny" when the corresponding match criteria are satisfied. Use deny-first ordering when enforcing strict boundaries with explicit allow exceptions.',
  "session.sendPolicy.rules[].match":
    "Defines optional rule match conditions that can combine channel, chatType, and key-prefix constraints. Keep matches narrow so policy intent stays readable and debugging remains straightforward.",
  "session.sendPolicy.rules[].match.channel":
    "Matches rule application to a specific channel/provider id (for example discord, telegram, slack). Use this when one channel should permit or deny delivery independently of others.",
  "session.sendPolicy.rules[].match.chatType":
    "Matches rule application to chat type (direct, group, thread) so behavior varies by conversation form. Use this when DM and group destinations require different safety boundaries.",
  "session.sendPolicy.rules[].match.keyPrefix":
    "Matches a normalized session-key prefix after internal key normalization steps in policy consumers. Use this for general prefix controls, and prefer rawKeyPrefix when exact full-key matching is required.",
  "session.sendPolicy.rules[].match.rawKeyPrefix":
    "Matches the raw, unnormalized session-key prefix for exact full-key policy targeting. Use this when normalized keyPrefix is too broad and you need agent-prefixed or transport-specific precision.",
  "session.agentToAgent":
    "Groups controls for inter-agent session exchanges, including loop prevention limits on reply chaining. Keep defaults unless you run advanced agent-to-agent automation with strict turn caps.",
  "session.agentToAgent.maxPingPongTurns":
    "Max reply-back turns between requester and target agents during agent-to-agent exchanges (0-5). Use lower values to hard-limit chatter loops and preserve predictable run completion.",
  "session.threadBindings":
    "Shared defaults for thread-bound session routing behavior across providers that support thread focus workflows. Configure global defaults here and override per channel only when behavior differs.",
  "session.threadBindings.enabled":
    "Global master switch for thread-bound session routing features and focused thread delivery behavior. Keep enabled for modern thread workflows unless you need to disable thread binding globally.",
  "session.threadBindings.ttlHours":
    "Default auto-unfocus TTL in hours for thread-bound sessions across providers/channels (0 disables). Keep 24h-like values for practical focus windows unless your team needs longer-lived thread binding.",
  "session.maintenance":
    "Automatic session-store maintenance controls for pruning age, entry caps, and file rotation behavior. Start in warn mode to observe impact, then enforce once thresholds are tuned.",
  "session.maintenance.mode":
    'Determines whether maintenance policies are only reported ("warn") or actively applied ("enforce"). Keep "warn" during rollout and switch to "enforce" after validating safe thresholds.',
  "session.maintenance.pruneAfter":
    "Removes entries older than this duration (for example `30d` or `12h`) during maintenance passes. Use this as the primary age-retention control and align it with data retention policy.",
  "session.maintenance.pruneDays":
    "Deprecated age-retention field kept for compatibility with legacy configs using day counts. Use session.maintenance.pruneAfter instead so duration syntax and behavior are consistent.",
  "session.maintenance.maxEntries":
    "Caps total session entry count retained in the store to prevent unbounded growth over time. Use lower limits for constrained environments, or higher limits when longer history is required.",
  "session.maintenance.rotateBytes":
    "Rotates the session store when file size exceeds a threshold such as `10mb` or `1gb`. Use this to bound single-file growth and keep backup/restore operations manageable.",
  "session.maintenance.resetArchiveRetention":
    "Retention for reset transcript archives (`*.reset.<timestamp>`). Accepts a duration (for example `30d`), or `false` to disable cleanup. Defaults to pruneAfter so reset artifacts do not grow forever.",
  "session.maintenance.maxDiskBytes":
    "Optional per-agent sessions-directory disk budget (for example `500mb`). Use this to cap session storage per agent; when exceeded, warn mode reports pressure and enforce mode performs oldest-first cleanup.",
  "session.maintenance.highWaterBytes":
    "Target size after disk-budget cleanup (high-water mark). Defaults to 80% of maxDiskBytes; set explicitly for tighter reclaim behavior on constrained disks.",
  cron: "Global scheduler settings for stored cron jobs, run concurrency, delivery fallback, and run-session retention. Keep defaults unless you are scaling job volume or integrating external webhook receivers.",
  "cron.enabled":
    "Enables cron job execution for stored schedules managed by the gateway. Keep enabled for normal reminder/automation flows, and disable only to pause all cron execution without deleting jobs.",
  "cron.store":
    "Path to the cron job store file used to persist scheduled jobs across restarts. Set an explicit path only when you need custom storage layout, backups, or mounted volumes.",
  "cron.maxConcurrentRuns":
    "Limits how many cron jobs can execute at the same time when multiple schedules fire together. Use lower values to protect CPU/memory under heavy automation load, or raise carefully for higher throughput.",
  "cron.webhook":
    'Deprecated legacy fallback webhook URL used only for old jobs with `notify=true`. Migrate to per-job delivery using `delivery.mode="webhook"` plus `delivery.to`, and avoid relying on this global field.',
  "cron.webhookToken":
    "Bearer token attached to cron webhook POST deliveries when webhook mode is used. Prefer secret/env substitution and rotate this token regularly if shared webhook endpoints are internet-reachable.",
  "cron.sessionRetention":
    "Controls how long completed cron run sessions are kept before pruning (`24h`, `7d`, `1h30m`, or `false` to disable pruning; default: `24h`). Use shorter retention to reduce storage growth on high-frequency schedules.",
  "cron.runLog":
    "Pruning controls for per-job cron run history files under `cron/runs/<jobId>.jsonl`, including size and line retention.",
  "cron.runLog.maxBytes":
    "Maximum bytes per cron run-log file before pruning rewrites to the last keepLines entries (for example `2mb`, default `2000000`).",
  "cron.runLog.keepLines":
    "How many trailing run-log lines to retain when a file exceeds maxBytes (default `2000`). Increase for longer forensic history or lower for smaller disks.",
  hooks:
    "Inbound webhook automation surface for mapping external events into wake or agent actions in OpenClaw. Keep this locked down with explicit token/session/agent controls before exposing it beyond trusted networks.",
  "hooks.enabled":
    "Enables the hooks endpoint and mapping execution pipeline for inbound webhook requests. Keep disabled unless you are actively routing external events into the gateway.",
  "hooks.path":
    "HTTP path used by the hooks endpoint (for example `/hooks`) on the gateway control server. Use a non-guessable path and combine it with token validation for defense in depth.",
  "hooks.token":
    "Shared bearer token checked by hooks ingress for request authentication before mappings run. Use environment substitution and rotate regularly when webhook endpoints are internet-accessible.",
  "hooks.defaultSessionKey":
    "Fallback session key used for hook deliveries when a request does not provide one through allowed channels. Use a stable but scoped key to avoid mixing unrelated automation conversations.",
  "hooks.allowRequestSessionKey":
    "Allows callers to supply a session key in hook requests when true, enabling caller-controlled routing. Keep false unless trusted integrators explicitly need custom session threading.",
  "hooks.allowedSessionKeyPrefixes":
    "Allowlist of accepted session-key prefixes for inbound hook requests when caller-provided keys are enabled. Use narrow prefixes to prevent arbitrary session-key injection.",
  "hooks.allowedAgentIds":
    "Allowlist of agent IDs that hook mappings are allowed to target when selecting execution agents. Use this to constrain automation events to dedicated service agents.",
  "hooks.maxBodyBytes":
    "Maximum accepted webhook payload size in bytes before the request is rejected. Keep this bounded to reduce abuse risk and protect memory usage under bursty integrations.",
  "hooks.presets":
    "Named hook preset bundles applied at load time to seed standard mappings and behavior defaults. Keep preset usage explicit so operators can audit which automations are active.",
  "hooks.transformsDir":
    "Base directory for hook transform modules referenced by mapping transform.module paths. Use a controlled repo directory so dynamic imports remain reviewable and predictable.",
  "hooks.mappings":
    "Ordered mapping rules that match inbound hook requests and choose wake or agent actions with optional delivery routing. Use specific mappings first to avoid broad pattern rules capturing everything.",
  "hooks.mappings[].id":
    "Optional stable identifier for a hook mapping entry used for auditing, troubleshooting, and targeted updates. Use unique IDs so logs and config diffs can reference mappings unambiguously.",
  "hooks.mappings[].match":
    "Grouping object for mapping match predicates such as path and source before action routing is applied. Keep match criteria specific so unrelated webhook traffic does not trigger automations.",
  "hooks.mappings[].match.path":
    "Path match condition for a hook mapping, usually compared against the inbound request path. Use this to split automation behavior by webhook endpoint path families.",
  "hooks.mappings[].match.source":
    "Source match condition for a hook mapping, typically set by trusted upstream metadata or adapter logic. Use stable source identifiers so routing remains deterministic across retries.",
  "hooks.mappings[].action":
    'Mapping action type: "wake" triggers agent wake flow, while "agent" sends directly to agent handling. Use "agent" for immediate execution and "wake" when heartbeat-driven processing is preferred.',
  "hooks.mappings[].wakeMode":
    'Wake scheduling mode: "now" wakes immediately, while "next-heartbeat" defers until the next heartbeat cycle. Use deferred mode for lower-priority automations that can tolerate slight delay.',
  "hooks.mappings[].name":
    "Human-readable mapping display name used in diagnostics and operator-facing config UIs. Keep names concise and descriptive so routing intent is obvious during incident review.",
  "hooks.mappings[].agentId":
    "Target agent ID for mapping execution when action routing should not use defaults. Use dedicated automation agents to isolate webhook behavior from interactive operator sessions.",
  "hooks.mappings[].sessionKey":
    "Explicit session key override for mapping-delivered messages to control thread continuity. Use stable scoped keys so repeated events correlate without leaking into unrelated conversations.",
  "hooks.mappings[].messageTemplate":
    "Template for synthesizing structured mapping input into the final message content sent to the target action path. Keep templates deterministic so downstream parsing and behavior remain stable.",
  "hooks.mappings[].textTemplate":
    "Text-only fallback template used when rich payload rendering is not desired or not supported. Use this to provide a concise, consistent summary string for chat delivery surfaces.",
  "hooks.mappings[].deliver":
    "Controls whether mapping execution results are delivered back to a channel destination versus being processed silently. Disable delivery for background automations that should not post user-facing output.",
  "hooks.mappings[].allowUnsafeExternalContent":
    "When true, mapping content may include less-sanitized external payload data in generated messages. Keep false by default and enable only for trusted sources with reviewed transform logic.",
  "hooks.mappings[].channel":
    'Delivery channel override for mapping outputs (for example "last", "telegram", "discord", "slack", "signal", "imessage", or "msteams"). Keep channel overrides explicit to avoid accidental cross-channel sends.',
  "hooks.mappings[].to":
    "Destination identifier inside the selected channel when mapping replies should route to a fixed target. Verify provider-specific destination formats before enabling production mappings.",
  "hooks.mappings[].model":
    "Optional model override for mapping-triggered runs when automation should use a different model than agent defaults. Use this sparingly so behavior remains predictable across mapping executions.",
  "hooks.mappings[].thinking":
    "Optional thinking-effort override for mapping-triggered runs to tune latency versus reasoning depth. Keep low or minimal for high-volume hooks unless deeper reasoning is clearly required.",
  "hooks.mappings[].timeoutSeconds":
    "Maximum runtime allowed for mapping action execution before timeout handling applies. Use tighter limits for high-volume webhook sources to prevent queue pileups.",
  "hooks.mappings[].transform":
    "Transform configuration block defining module/export preprocessing before mapping action handling. Use transforms only from reviewed code paths and keep behavior deterministic for repeatable automation.",
  "hooks.mappings[].transform.module":
    "Relative transform module path loaded from hooks.transformsDir to rewrite incoming payloads before delivery. Keep modules local, reviewed, and free of path traversal patterns.",
  "hooks.mappings[].transform.export":
    "Named export to invoke from the transform module; defaults to module default export when omitted. Set this when one file hosts multiple transform handlers.",
  "hooks.gmail":
    "Gmail push integration settings used for Pub/Sub notifications and optional local callback serving. Keep this scoped to dedicated Gmail automation accounts where possible.",
  "hooks.gmail.account":
    "Google account identifier used for Gmail watch/subscription operations in this hook integration. Use a dedicated automation mailbox account to isolate operational permissions.",
  "hooks.gmail.label":
    "Optional Gmail label filter limiting which labeled messages trigger hook events. Keep filters narrow to avoid flooding automations with unrelated inbox traffic.",
  "hooks.gmail.topic":
    "Google Pub/Sub topic name used by Gmail watch to publish change notifications for this account. Ensure the topic IAM grants Gmail publish access before enabling watches.",
  "hooks.gmail.subscription":
    "Pub/Sub subscription consumed by the gateway to receive Gmail change notifications from the configured topic. Keep subscription ownership clear so multiple consumers do not race unexpectedly.",
  "hooks.gmail.hookUrl":
    "Public callback URL Gmail or intermediaries invoke to deliver notifications into this hook pipeline. Keep this URL protected with token validation and restricted network exposure.",
  "hooks.gmail.includeBody":
    "When true, fetch and include email body content for downstream mapping/agent processing. Keep false unless body text is required, because this increases payload size and sensitivity.",
  "hooks.gmail.allowUnsafeExternalContent":
    "Allows less-sanitized external Gmail content to pass into processing when enabled. Keep disabled for safer defaults, and enable only for trusted mail streams with controlled transforms.",
  "hooks.gmail.serve":
    "Local callback server settings block for directly receiving Gmail notifications without a separate ingress layer. Enable only when this process should terminate webhook traffic itself.",
  "hooks.gmail.pushToken":
    "Shared secret token required on Gmail push hook callbacks before processing notifications. Use env substitution and rotate if callback endpoints are exposed externally.",
  "hooks.gmail.maxBytes":
    "Maximum Gmail payload bytes processed per event when includeBody is enabled. Keep conservative limits to reduce oversized message processing cost and risk.",
  "hooks.gmail.renewEveryMinutes":
    "Renewal cadence in minutes for Gmail watch subscriptions to prevent expiration. Set below provider expiration windows and monitor renew failures in logs.",
  "hooks.gmail.serve.bind":
    "Bind address for the local Gmail callback HTTP server used when serving hooks directly. Keep loopback-only unless external ingress is intentionally required.",
  "hooks.gmail.serve.port":
    "Port for the local Gmail callback HTTP server when serve mode is enabled. Use a dedicated port to avoid collisions with gateway/control interfaces.",
  "hooks.gmail.serve.path":
    "HTTP path on the local Gmail callback server where push notifications are accepted. Keep this consistent with subscription configuration to avoid dropped events.",
  "hooks.gmail.tailscale.mode":
    'Tailscale exposure mode for Gmail callbacks: "off", "serve", or "funnel". Use "serve" for private tailnet delivery and "funnel" only when public internet ingress is required.',
  "hooks.gmail.tailscale":
    "Tailscale exposure configuration block for publishing Gmail callbacks through Serve/Funnel routes. Use private tailnet modes before enabling any public ingress path.",
  "hooks.gmail.tailscale.path":
    "Path published by Tailscale Serve/Funnel for Gmail callback forwarding when enabled. Keep it aligned with Gmail webhook config so requests reach the expected handler.",
  "hooks.gmail.tailscale.target":
    "Local service target forwarded by Tailscale Serve/Funnel (for example http://127.0.0.1:8787). Use explicit loopback targets to avoid ambiguous routing.",
  "hooks.gmail.model":
    "Optional model override for Gmail-triggered runs when mailbox automations should use dedicated model behavior. Keep unset to inherit agent defaults unless mailbox tasks need specialization.",
  "hooks.gmail.thinking":
    'Thinking effort override for Gmail-driven agent runs: "off", "minimal", "low", "medium", or "high". Keep modest defaults for routine inbox automations to control cost and latency.',
  "hooks.internal":
    "Internal hook runtime settings for bundled/custom event handlers loaded from module paths. Use this for trusted in-process automations and keep handler loading tightly scoped.",
  "hooks.internal.enabled":
    "Enables processing for internal hook handlers and configured entries in the internal hook runtime. Keep disabled unless internal hook handlers are intentionally configured.",
  "hooks.internal.handlers":
    "List of internal event handlers mapping event names to modules and optional exports. Keep handler definitions explicit so event-to-code routing is auditable.",
  "hooks.internal.handlers[].event":
    "Internal event name that triggers this handler module when emitted by the runtime. Use stable event naming conventions to avoid accidental overlap across handlers.",
  "hooks.internal.handlers[].module":
    "Safe relative module path for the internal hook handler implementation loaded at runtime. Keep module files in reviewed directories and avoid dynamic path composition.",
  "hooks.internal.handlers[].export":
    "Optional named export for the internal hook handler function when module default export is not used. Set this when one module ships multiple handler entrypoints.",
  "hooks.internal.entries":
    "Configured internal hook entry records used to register concrete runtime handlers and metadata. Keep entries explicit and versioned so production behavior is auditable.",
  "hooks.internal.load":
    "Internal hook loader settings controlling where handler modules are discovered at startup. Use constrained load roots to reduce accidental module conflicts or shadowing.",
  "hooks.internal.load.extraDirs":
    "Additional directories searched for internal hook modules beyond default load paths. Keep this minimal and controlled to reduce accidental module shadowing.",
  "hooks.internal.installs":
    "Install metadata for internal hook modules, including source and resolved artifacts for repeatable deployments. Use this as operational provenance and avoid manual drift edits.",
  messages:
    "Message formatting, acknowledgment, queueing, debounce, and status reaction behavior for inbound/outbound chat flows. Use this section when channel responsiveness or message UX needs adjustment.",
  "messages.messagePrefix":
    "Prefix text prepended to inbound user messages before they are handed to the agent runtime. Use this sparingly for channel context markers and keep it stable across sessions.",
  "messages.responsePrefix":
    "Prefix text prepended to outbound assistant replies before sending to channels. Use for lightweight branding/context tags and avoid long prefixes that reduce content density.",
  "messages.groupChat":
    "Group-message handling controls including mention triggers and history window sizing. Keep mention patterns narrow so group channels do not trigger on every message.",
  "messages.groupChat.mentionPatterns":
    "Regex-like patterns used to detect explicit mentions/trigger phrases in group chats. Use precise patterns to reduce false positives in high-volume channels.",
  "messages.groupChat.historyLimit":
    "Maximum number of prior group messages loaded as context per turn for group sessions. Use higher values for richer continuity, or lower values for faster and cheaper responses.",
  "messages.queue":
    "Inbound message queue strategy used to buffer bursts before processing turns. Tune this for busy channels where sequential processing or batching behavior matters.",
  "messages.queue.mode":
    'Queue behavior mode: "steer", "followup", "collect", "steer-backlog", "steer+backlog", "queue", or "interrupt". Keep conservative modes unless you intentionally need aggressive interruption/backlog semantics.',
  "messages.queue.byChannel":
    "Per-channel queue mode overrides keyed by provider id (for example telegram, discord, slack). Use this when one channel’s traffic pattern needs different queue behavior than global defaults.",
  "messages.queue.debounceMs":
    "Global queue debounce window in milliseconds before processing buffered inbound messages. Use higher values to coalesce rapid bursts, or lower values for reduced response latency.",
  "messages.queue.debounceMsByChannel":
    "Per-channel debounce overrides for queue behavior keyed by provider id. Use this to tune burst handling independently for chat surfaces with different pacing.",
  "messages.queue.cap":
    "Maximum number of queued inbound items retained before drop policy applies. Keep caps bounded in noisy channels so memory usage remains predictable.",
  "messages.queue.drop":
    'Drop strategy when queue cap is exceeded: "old", "new", or "summarize". Use summarize when preserving intent matters, or old/new when deterministic dropping is preferred.',
  "messages.inbound":
    "Direct inbound debounce settings used before queue/turn processing starts. Configure this for provider-specific rapid message bursts from the same sender.",
  "messages.inbound.byChannel":
    "Per-channel inbound debounce overrides keyed by provider id in milliseconds. Use this where some providers send message fragments more aggressively than others.",
  "messages.removeAckAfterReply":
    "Removes the acknowledgment reaction after final reply delivery when enabled. Keep enabled for cleaner UX in channels where persistent ack reactions create clutter.",
  "messages.tts":
    "Text-to-speech policy for reading agent replies aloud on supported voice or audio surfaces. Keep disabled unless voice playback is part of your operator/user workflow.",
  channels:
    "Channel provider configurations plus shared defaults that control access policies, heartbeat visibility, and per-surface behavior. Keep defaults centralized and override per provider only where required.",
  "channels.telegram":
    "Telegram channel provider configuration including auth tokens, retry behavior, and message rendering controls. Use this section to tune bot behavior for Telegram-specific API semantics.",
  "channels.slack":
    "Slack channel provider configuration for bot/app tokens, streaming behavior, and DM policy controls. Keep token handling and thread behavior explicit to avoid noisy workspace interactions.",
  "channels.discord":
    "Discord channel provider configuration for bot auth, retry policy, streaming, thread bindings, and optional voice capabilities. Keep privileged intents and advanced features disabled unless needed.",
  "channels.whatsapp":
    "WhatsApp channel provider configuration for access policy and message batching behavior. Use this section to tune responsiveness and direct-message routing safety for WhatsApp chats.",
  "channels.signal":
    "Signal channel provider configuration including account identity and DM policy behavior. Keep account mapping explicit so routing remains stable across multi-device setups.",
  "channels.imessage":
    "iMessage channel provider configuration for CLI integration and DM access policy handling. Use explicit CLI paths when runtime environments have non-standard binary locations.",
  "channels.bluebubbles":
    "BlueBubbles channel provider configuration used for Apple messaging bridge integrations. Keep DM policy aligned with your trusted sender model in shared deployments.",
  "channels.msteams":
    "Microsoft Teams channel provider configuration and provider-specific policy toggles. Use this section to isolate Teams behavior from other enterprise chat providers.",
  "channels.mattermost":
    "Mattermost channel provider configuration for bot credentials, base URL, and message trigger modes. Keep mention/trigger rules strict in high-volume team channels.",
  "channels.irc":
    "IRC channel provider configuration and compatibility settings for classic IRC transport workflows. Use this section when bridging legacy chat infrastructure into OpenClaw.",
  "channels.defaults":
    "Default channel behavior applied across providers when provider-specific settings are not set. Use this to enforce consistent baseline policy before per-provider tuning.",
  "channels.defaults.groupPolicy":
    'Default group policy across channels: "open", "disabled", or "allowlist". Keep "allowlist" for safer production setups unless broad group participation is intentional.',
  "channels.defaults.heartbeat":
    "Default heartbeat visibility settings for status messages emitted by providers/channels. Tune this globally to reduce noisy healthy-state updates while keeping alerts visible.",
  "channels.defaults.heartbeat.showOk":
    "Shows healthy/OK heartbeat status entries when true in channel status outputs. Keep false in noisy environments and enable only when operators need explicit healthy confirmations.",
  "channels.defaults.heartbeat.showAlerts":
    "Shows degraded/error heartbeat alerts when true so operator channels surface problems promptly. Keep enabled in production so broken channel states are visible.",
  "channels.defaults.heartbeat.useIndicator":
    "Enables concise indicator-style heartbeat rendering instead of verbose status text where supported. Use indicator mode for dense dashboards with many active channels.",
  "channels.telegram.configWrites":
    "Allow Telegram to write config in response to channel events/commands (default: true).",
  "channels.telegram.botToken":
    "Telegram bot token used to authenticate Bot API requests for this account/provider config. Use secret/env substitution and rotate tokens if exposure is suspected.",
  "channels.telegram.capabilities.inlineButtons":
    "Enable Telegram inline button components for supported command and interaction surfaces. Disable if your deployment needs plain-text-only compatibility behavior.",
  "channels.slack.configWrites":
    "Allow Slack to write config in response to channel events/commands (default: true).",
  "channels.slack.botToken":
    "Slack bot token used for standard chat actions in the configured workspace. Keep this credential scoped and rotate if workspace app permissions change.",
  "channels.slack.appToken":
    "Slack app-level token used for Socket Mode connections and event transport when enabled. Use least-privilege app scopes and store this token as a secret.",
  "channels.slack.userToken":
    "Optional Slack user token for workflows requiring user-context API access beyond bot permissions. Use sparingly and audit scopes because this token can carry broader authority.",
  "channels.slack.userTokenReadOnly":
    "When true, treat configured Slack user token usage as read-only helper behavior where possible. Keep enabled if you only need supplemental reads without user-context writes.",
  "channels.mattermost.configWrites":
    "Allow Mattermost to write config in response to channel events/commands (default: true).",
  "channels.discord.configWrites":
    "Allow Discord to write config in response to channel events/commands (default: true).",
  "channels.discord.token":
    "Discord bot token used for gateway and REST API authentication for this provider account. Keep this secret out of committed config and rotate immediately after any leak.",
  "channels.discord.proxy":
    "Proxy URL for Discord gateway + API requests (app-id lookup and allowlist resolution). Set per account via channels.discord.accounts.<id>.proxy.",
  "channels.whatsapp.configWrites":
    "Allow WhatsApp to write config in response to channel events/commands (default: true).",
  "channels.signal.configWrites":
    "Allow Signal to write config in response to channel events/commands (default: true).",
  "channels.signal.account":
    "Signal account identifier (phone/number handle) used to bind this channel config to a specific Signal identity. Keep this aligned with your linked device/session state.",
  "channels.imessage.configWrites":
    "Allow iMessage to write config in response to channel events/commands (default: true).",
  "channels.imessage.cliPath":
    "Filesystem path to the iMessage bridge CLI binary used for send/receive operations. Set explicitly when the binary is not on PATH in service runtime environments.",
  "channels.msteams.configWrites":
    "Allow Microsoft Teams to write config in response to channel events/commands (default: true).",
  "channels.modelByChannel":
    "Map provider -> channel id -> model override (values are provider/model or aliases).",
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
  "channels.slack.streaming":
    'Unified Slack stream preview mode: "off" | "partial" | "block" | "progress". Legacy boolean/streamMode keys are auto-mapped.',
  "channels.slack.nativeStreaming":
    "Enable native Slack text streaming (chat.startStream/chat.appendStream/chat.stopStream) when channels.slack.streaming is partial (default: true).",
  "channels.slack.streamMode":
    "Legacy Slack preview mode alias (replace | status_final | append); auto-migrated to channels.slack.streaming.",
  "channels.telegram.customCommands":
    "Additional Telegram bot menu commands (merged with native; conflicts ignored).",
  "messages.suppressToolErrors":
    "When true, suppress ⚠️ tool-error warnings from being shown to the user. The agent already sees errors in context and can retry. Default: false.",
  "messages.ackReaction": "Emoji reaction used to acknowledge inbound messages (empty disables).",
  "messages.ackReactionScope":
    'When to send ack reactions ("group-mentions", "group-all", "direct", "all").',
  "messages.statusReactions":
    "Lifecycle status reactions that update the emoji on the trigger message as the agent progresses (queued → thinking → tool → done/error).",
  "messages.statusReactions.enabled":
    "Enable lifecycle status reactions for Telegram. When enabled, the ack reaction becomes the initial 'queued' state and progresses through thinking, tool, done/error automatically. Default: false.",
  "messages.statusReactions.emojis":
    "Override default status reaction emojis. Keys: thinking, tool, coding, web, done, error, stallSoft, stallHard. Must be valid Telegram reaction emojis.",
  "messages.statusReactions.timing":
    "Override default timing. Keys: debounceMs (700), stallSoftMs (25000), stallHardMs (60000), doneHoldMs (1500), errorHoldMs (2500).",
  "messages.inbound.debounceMs":
    "Debounce window (ms) for batching rapid inbound messages from the same sender (0 to disable).",
  "channels.telegram.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.telegram.allowFrom=["*"].',
  "channels.telegram.streaming":
    'Unified Telegram stream preview mode: "off" | "partial" | "block" | "progress". "progress" maps to "partial" on Telegram. Legacy boolean/streamMode keys are auto-mapped.',
  "channels.discord.streaming":
    'Unified Discord stream preview mode: "off" | "partial" | "block" | "progress". "progress" maps to "partial" on Discord. Legacy boolean/streamMode keys are auto-mapped.',
  "channels.discord.streamMode":
    "Legacy Discord preview mode alias (off | partial | block); auto-migrated to channels.discord.streaming.",
  "channels.discord.draftChunk.minChars":
    'Minimum chars before emitting a Discord stream preview update when channels.discord.streaming="block" (default: 200).',
  "channels.discord.draftChunk.maxChars":
    'Target max size for a Discord stream preview chunk when channels.discord.streaming="block" (default: 800; clamped to channels.discord.textChunkLimit).',
  "channels.discord.draftChunk.breakPreference":
    "Preferred breakpoints for Discord draft chunks (paragraph | newline | sentence). Default: paragraph.",
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
  "channels.discord.threadBindings.enabled":
    "Enable Discord thread binding features (/focus, bound-thread routing/delivery, and thread-bound subagent sessions). Overrides session.threadBindings.enabled when set.",
  "channels.discord.threadBindings.ttlHours":
    "Auto-unfocus TTL in hours for Discord thread-bound sessions (/focus and spawned thread sessions). Set 0 to disable (default: 24). Overrides session.threadBindings.ttlHours when set.",
  "channels.discord.threadBindings.spawnSubagentSessions":
    "Allow subagent spawns with thread=true to auto-create and bind Discord threads (default: false; opt-in). Set true to enable thread-bound subagent spawns for this account/channel.",
  "channels.discord.ui.components.accentColor":
    "Accent color for Discord component containers (hex). Set per account via channels.discord.accounts.<id>.ui.components.accentColor.",
  "channels.discord.voice.enabled":
    "Enable Discord voice channel conversations (default: true). Omit channels.discord.voice to keep voice support disabled for the account.",
  "channels.discord.voice.autoJoin":
    "Voice channels to auto-join on startup (list of guildId/channelId entries).",
  "channels.discord.voice.tts":
    "Optional TTS overrides for Discord voice playback (merged with messages.tts).",
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
