import type { z } from "zod";
import type { ControlUiEnvironment } from "../gateway/control-ui-bootstrap-contract.js";
// Defines gateway runtime and networking configuration types.
import type { OperatorScope } from "../gateway/operator-scopes.js";
import type { SecretInput } from "./types.secrets.js";
import type { GatewayConfigSchema } from "./zod-schema.gateway.js";

type GatewayConfigInput = NonNullable<z.input<typeof GatewayConfigSchema>>;

/** Gateway bind-address policy for local server startup. */
export type GatewayBindMode = NonNullable<GatewayConfigInput["bind"]>;

export type GatewayTlsConfig = NonNullable<GatewayConfigInput["tls"]>;

export type WideAreaDiscoveryConfig = {
  /** Optional unicast DNS-SD domain (e.g. "openclaw.internal"). */
  domain?: string;
};

/** mDNS/Bonjour metadata exposure level for local gateway discovery. */
export type MdnsDiscoveryMode = "off" | "minimal" | "full";

export type MdnsDiscoveryConfig = {
  /**
   * mDNS/Bonjour discovery broadcast mode (default: minimal).
   * - off: disable mDNS entirely
   * - minimal: omit cliPath/sshPort from TXT records
   * - full: include cliPath/sshPort in TXT records
   */
  mode?: MdnsDiscoveryMode;
};

export type DiscoveryConfig = {
  /** Wide-area DNS-SD discovery settings. */
  wideArea?: WideAreaDiscoveryConfig;
  /** Local mDNS/Bonjour discovery settings. */
  mdns?: MdnsDiscoveryConfig;
};

export type TalkProviderConfig = {
  /** Provider API key (optional; provider-specific env fallback may apply). */
  apiKey?: SecretInput;
  /** Provider-owned Talk config fields. */
  [key: string]: unknown;
};

export type TalkRealtimeConfig = {
  /** Active realtime voice provider. */
  provider?: string;
  /** Provider-specific realtime voice config keyed by provider id. */
  providers?: Record<string, TalkProviderConfig>;
  /** Provider model override for realtime sessions. */
  model?: string;
  /** Provider speaker voice name override for realtime sessions. */
  speakerVoice?: string;
  /** Provider speaker voice id override for realtime sessions. */
  speakerVoiceId?: string;
  /** Additional system instructions appended to realtime Talk sessions. */
  instructions?: string;
  /** Realtime execution mode. */
  mode?: "realtime" | "stt-tts" | "transcription";
  /** Byte/session transport. */
  transport?: "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room";
  /** Voice activity detection threshold from 0 (most sensitive) to 1 (least sensitive). */
  vadThreshold?: number;
  /** Milliseconds of silence before the current user turn is committed. */
  silenceDurationMs?: number;
  /** Milliseconds of audio retained before detected speech begins. */
  prefixPaddingMs?: number;
  /** Provider-specific realtime reasoning effort. */
  reasoningEffort?: string;
  /** Tool/agent strategy for realtime sessions. */
  brain?: "agent-consult" | "direct-tools" | "none";
  /** How Gateway relay handles final user transcripts when the provider skips a consult. */
  consultRouting?: "provider-direct" | "force-agent-consult";
};

export type ResolvedTalkConfig = {
  /** Active Talk TTS provider resolved from the current config payload. */
  provider: string;
  /** Provider config for the active Talk provider. */
  config: TalkProviderConfig;
};

export type TalkConfig = {
  /** Agent that owns Talk sessions created without an agent-scoped session key. */
  agentId?: string;
  /** Active Talk TTS provider (for example "acme-speech"). */
  provider?: string;
  /** Provider-specific Talk config keyed by provider id. */
  providers?: Record<string, TalkProviderConfig>;
  /** Realtime Talk provider, model, voice, mode, transport, and brain config. */
  realtime?: TalkRealtimeConfig;
  /** Optional thinking level override for the agent run behind Talk realtime consults. */
  consultThinkingLevel?:
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "adaptive"
    | "max"
    | "ultra";
  /** Optional fast mode override for the agent run behind Talk realtime consults. */
  consultFastMode?: boolean;
  /** BCP 47 locale id used for Talk speech recognition on device nodes and the iOS system-voice fallback. */
  speechLocale?: string;
  /** Stop speaking when user starts talking (default: true). */
  interruptOnSpeech?: boolean;
  /** Milliseconds of user silence before Talk mode sends the transcript after a pause. */
  silenceTimeoutMs?: number;
};

export type TalkConfigResponse = TalkConfig & {
  /** Canonical active Talk payload for clients. */
  resolved?: ResolvedTalkConfig;
};

export type GatewayControlUiConfig = {
  /** @deprecated Doctor-only legacy input. */
  chatMessageMaxWidth?: string;
  /**
   * @deprecated Upgrade-only transport input. Retained so releases that shipped
   * this break-glass flag can migrate an unpaired browser safely.
   */
  dangerouslyDisableDeviceAuth?: boolean;
  /** If false, the Gateway will not serve the Control UI (default /). */
  enabled?: boolean;
  /** Optional base path prefix for the Control UI (e.g. "/openclaw"). */
  basePath?: string;
  experimental?: {
    /** Allow native UI from user-installed plugins (default false; bundled UI stays available). */
    customPlugins?: boolean;
  };
  /** Optional filesystem root for Control UI assets (defaults to dist/control-ui). */
  root?: string;
  /** Optional visual label and named color distinguishing this Gateway environment. */
  environment?: ControlUiEnvironment;
  /** Show the Discord community invitation in this Gateway's Control UI (default true). */
  communityInvite?: boolean;
  /** Optional service credential used only for Control UI GitHub previews and discovery. */
  github?: { token?: SecretInput };
  /** Produce utility-model session status digests for subscribed Control UI clients (default true). */
  sessionObserver?: boolean;
  /**
   * Embed sandbox mode for hosted Control UI previews.
   * - strict: no script execution inside embeds
   * - scripts: allow scripts while keeping embeds origin-isolated (default)
   * - trusted: allow scripts and same-origin privileges
   */
  embedSandbox?: "strict" | "scripts" | "trusted";
  /**
   * DANGEROUS: Allow hosted embeds to load absolute external http(s) URLs.
   * Default off; prefer hosted /__openclaw__/canvas or /__openclaw__/a2ui content.
   */
  allowExternalEmbedUrls?: boolean;
  /** Fetch public-site favicons through the Gateway for Control UI links (default true). */
  automaticallyFetchFavicons?: boolean;
  /** Optional max-width for grouped Control UI chat messages (default: min(900px, 68%)). */
  /** Allowed browser origins for Control UI/WebChat websocket connections. */
  allowedOrigins?: string[];
  /**
   * DANGEROUS: Keep Host-header origin fallback behavior.
   * Supported long-term for deployments that intentionally rely on this policy.
   */
  dangerouslyAllowHostHeaderOriginFallback?: boolean;
};

/** Gateway authentication strategy for WebSocket and HTTP clients. */
export type GatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";

/**
 * Configuration for trusted reverse proxy authentication.
 * Used when Clawdbot runs behind an identity-aware proxy (Pomerium, Caddy + OAuth, etc.)
 * that handles authentication and passes user identity via headers.
 */
export type GatewayTrustedProxyConfig = {
  /**
   * Header name containing the authenticated user identity (required).
   * Common values: "x-forwarded-user", "x-remote-user", "x-pomerium-claim-email"
   */
  userHeader: string;
  /**
   * Additional headers that MUST be present for the request to be trusted.
   * Use this to verify the request actually came through the proxy.
   * Example: ["x-forwarded-proto", "x-forwarded-host"]
   */
  requiredHeaders?: string[];
  /**
   * Optional allowlist of user identities that can access the gateway.
   * If empty or omitted, all authenticated users from the proxy are allowed.
   * Example: ["nick@example.com", "admin@company.org"]
   */
  allowUsers?: string[];
  /**
   * Allow loopback proxy sources (127.0.0.1, ::1) in trusted-proxy mode.
   * Default false; enable only when a same-host reverse proxy is the intended
   * trust boundary and direct Gateway access is otherwise locked down.
   */
  allowLoopback?: boolean;
  /**
   * Automatically approve new browser/native UI operator devices and same-key scope upgrades after
   * trusted-proxy authentication. Disabled by default; configured scopes cap grants.
   */
  deviceAutoApprove?: {
    /** Enable automatic browser enrollment and same-key scope upgrades. @default false */
    enabled?: boolean;
    /**
     * Maximum operator scopes granted by automatic approval. Listing
     * operator.admin explicitly lets every proxy-authenticated user request
     * automatic full-admin device grants. Requests without scopes receive the
     * configured maximum. @default operator.read, operator.write,
     * operator.approvals, operator.questions
     */
    scopes?: string[];
  };
};

export type GatewayAuthConfig = {
  /**
   * Authentication mode for Gateway connections. Token/password mode selects the
   * configured secret; clients may send it in either auth.token or auth.password.
   */
  mode?: GatewayAuthMode;
  /** Shared secret selected by token mode (plaintext or SecretRef). */
  token?: SecretInput;
  /** Shared secret selected by password mode (plaintext or SecretRef; consider env instead). */
  password?: SecretInput;
  /** Allow Tailscale identity headers when serve mode is enabled. */
  allowTailscale?: boolean;
  /** Operator scopes granted to verified trusted-proxy or Tailscale identities. */
  identityScopes?: Record<string, OperatorScope[]>;
  /** Rate-limit configuration for failed authentication attempts. */
  rateLimit?: GatewayAuthRateLimitConfig;
  /**
   * Configuration for trusted-proxy auth mode.
   * Required when mode is "trusted-proxy".
   */
  trustedProxy?: GatewayTrustedProxyConfig;
};

export type GatewayAuthRateLimitConfig = {
  /** Maximum failed attempts per IP before blocking.  @default 10 */
  maxAttempts?: number;
  /** Sliding window duration in milliseconds.  @default 60000 (1 min) */
  windowMs?: number;
  /** Lockout duration in milliseconds after the limit is exceeded.  @default 300000 (5 min) */
  lockoutMs?: number;
  /** Exempt localhost/loopback addresses from auth rate limiting.  @default true */
  exemptLoopback?: boolean;
};

/** Tailscale exposure mode for gateway HTTP/WebSocket surfaces. */
export type GatewayTailscaleMode = "off" | "serve" | "funnel";

export type GatewayTailscaleConfig = {
  /** Tailscale exposure mode for the Gateway control UI. */
  mode?: GatewayTailscaleMode;
  /**
   * Detect an external Funnel route left on the ordinary Gateway listener and
   * leave exposure unchanged with migration guidance. Gateway-authenticated
   * routes reject that ingress; plugin-authenticated webhooks keep their owner auth.
   * @deprecated Migrate to `mode="funnel"`, which uses managed ingress.
   */
  preserveFunnel?: boolean;
};

export type GatewayRemoteConfig = NonNullable<GatewayConfigInput["remote"]>;

/**
 * Operator terminal surface served to Control UI and mobile clients.
 *
 * The terminal opens a PTY-backed shell on the gateway host, gated to
 * admin-scope operator sessions. It starts in the target agent's workspace; if
 * that agent is fully sandboxed (`sandbox.mode: "all"`) the terminal is refused
 * rather than handed an unconfined host shell (workspace isolation is
 * fail-closed). Under "non-main" the agent's main session runs on the host, so a
 * host terminal is allowed.
 */
export type GatewayTerminalConfig = {
  /** Master switch for the operator terminal. Default: true; set false to opt out. */
  enabled?: boolean;
  /**
   * Shell executable to launch. When unset the host login shell is used
   * ($SHELL on Unix, %ComSpec% on Windows).
   */
  shell?: string;
  /**
   * How long (seconds) a session survives after its connection drops, staying
   * reattachable via terminal.attach. 0 kills sessions on disconnect
   * immediately. Default: 300.
   */
  detachedSessionTimeoutSeconds?: number;
};

/** Labs-gated external CLI session targets in the Control UI. */
export type GatewayCliAgentsConfig = {
  /** Show catalog-backed CLI agents in the new-session model picker. Default: true. */
  enabled?: boolean;
};

/** Gateway config reload strategy for managed installs. */
export type GatewayReloadMode = "off" | "restart" | "hot" | "hybrid";

export type GatewayReloadConfig = {
  /** Reload strategy for config changes (default: hybrid). */
  mode?: GatewayReloadMode;
};

type GatewayHttpConfigInput = NonNullable<GatewayConfigInput["http"]>;
type GatewayHttpEndpointsConfigInput = NonNullable<GatewayHttpConfigInput["endpoints"]>;

export type GatewayHttpChatCompletionsConfig = NonNullable<
  GatewayHttpEndpointsConfigInput["chatCompletions"]
>;
export type GatewayHttpChatCompletionsImagesConfig = NonNullable<
  GatewayHttpChatCompletionsConfig["images"]
>;

export type GatewayHttpResponsesConfig = NonNullable<GatewayHttpEndpointsConfigInput["responses"]>;

export type GatewayHttpResponsesFilesConfig = NonNullable<GatewayHttpResponsesConfig["files"]>;

export type GatewayHttpResponsesPdfConfig = NonNullable<GatewayHttpResponsesFilesConfig["pdf"]>;

export type GatewayHttpResponsesImagesConfig = NonNullable<GatewayHttpResponsesConfig["images"]>;

export type GatewayHttpEndpointsConfig = GatewayHttpEndpointsConfigInput;

export type GatewayHttpSecurityHeadersConfig = NonNullable<
  GatewayHttpConfigInput["securityHeaders"]
>;

export type GatewayHttpConfig = GatewayHttpConfigInput;

export type GatewayPushConfig = NonNullable<GatewayConfigInput["push"]>;
export type GatewayPushApnsConfig = NonNullable<GatewayPushConfig["apns"]>;
export type GatewayPushApnsRelayConfig = NonNullable<GatewayPushApnsConfig["relay"]>;

export type GatewayNodePairingConfig = {
  /**
   * Silently approve trusted local device pairing and access upgrades.
   * Set false to require explicit approval; metadata refreshes remain automatic.
   * Default: true.
   */
  autoApproveLocal?: boolean;
  /**
   * Opt-in CIDR/IP allowlist for auto-approving first-time node-role pairing.
   * Only applies to fresh node pairing requests with no requested scopes.
   * Default: unset/disabled.
   */
  autoApproveCidrs?: string[];
  /**
   * SSH-verified auto-approval for first-time node-role pairing (default: enabled).
   * The gateway connects back to the pairing host over SSH (BatchMode, strict
   * host keys) and approves only when the remote `openclaw node identity`
   * output matches the pending request's device key. Set false to disable SSH
   * verification; this is independent of autoApproveCidrs, so unset that too for
   * manual-only node pairing. The object form tunes the probe:
   * - user: remote user (default: gateway process user)
   * - identity: SSH identity file (default: standard SSH resolution)
   * - timeoutMs: probe timeout (default: 7000)
   * - cidrs: CIDRs/IPs eligible for probing (default: private/CGNAT ranges)
   */
  sshVerify?:
    | boolean
    | {
        user?: string;
        identity?: string;
        timeoutMs?: number;
        cidrs?: string[];
      };
};

export type GatewayNodesConfig = {
  /** @deprecated Doctor-only legacy input. */
  skills?: { enabled?: boolean };
  /** @deprecated Doctor-only legacy input. */
  allowCommands?: string[];
  /** @deprecated Doctor-only legacy input. */
  denyCommands?: string[];
  /** Browser routing policy for node-hosted browser proxies. */
  browser?: {
    /** Routing mode (default: auto). */
    mode?: "auto" | "manual" | "off";
    /** Pin to a specific node id/name (optional). */
    node?: string;
  };
  /** Pairing policy for node-role gateway clients. */
  pairing?: GatewayNodePairingConfig;
  /** Controls whether paired nodes may publish agent-visible plugin tools (default: true). */
  pluginTools?: {
    /** Accept node-published plugin tool descriptors (default: true). */
    enabled?: boolean;
  };
  /** Accept node-published skill descriptors (default: true). */
  allowSkills?: boolean;
  commands?: {
    /** Additional node.invoke commands to allow on the gateway. */
    allow?: string[];
    /** Commands to deny even if they appear in the defaults or node claims. */
    deny?: string[];
  };
};

export type GatewayToolsConfig = {
  /** Tools to deny via gateway HTTP /tools/invoke (extends defaults). */
  deny?: string[];
  /** Tools to explicitly allow (removes from default deny list). */
  allow?: string[];
};

/** Closed session, sandbox, agent, and operator-scope policy for one named team role. */
export type GatewayOperatorRoleDefinition = {
  sessions: {
    /** Maximum access to another person's sessions without explicit membership. */
    others: "none" | "view" | "suggest" | "write";
  };
  /** Require sandbox isolation for newly created sessions, or inherit agent policy by default. */
  sandbox?: "inherit" | "required";
  /** Agent IDs available for session creation and runs, or all agents when set to "*". */
  agents: "*" | string[];
  /** Ceiling applied to the authenticated profile's granted operator scopes. */
  scopes: OperatorScope[];
};

/** Optional named operator-role policies for Gateway deployments shared by a team. */
export type GatewayOperatorRolesConfig = {
  /** Required validated default for profiles without a valid assigned role. */
  default?: string;
  /** Closed capability bundles indexed by administrator-selected role names. */
  definitions: Record<string, GatewayOperatorRoleDefinition>;
};

export type GatewayConfig = {
  /** Single multiplexed port for Gateway WS + HTTP (default: 18789). */
  port?: number;
  /**
   * Explicit gateway mode. When set to "remote", local gateway start is disabled.
   * When set to "local", the CLI may start the gateway locally.
   */
  mode?: "local" | "remote";
  /**
   * Bind address policy for the Gateway WebSocket + Control UI HTTP server.
   * - auto: Loopback (127.0.0.1) if available, else 0.0.0.0 (fallback to all interfaces)
   * - lan: 0.0.0.0 (all interfaces, no fallback, current BYOH path is IPv4-only)
   * - loopback: 127.0.0.1 (local-only)
   * - tailnet: Tailnet IPv4 plus 127.0.0.1 if available, else loopback only
   * - custom: User-specified IPv4 address (requires customBindHost); specific IPv4s also bind 127.0.0.1
   * IPv6-only BYOH is not natively supported on this path today. Use an IPv4 sidecar or proxy.
   * Default: loopback (127.0.0.1).
   */
  bind?: GatewayBindMode;
  /** Custom IPv4 address for bind="custom" mode. IPv6-only BYOH requires an IPv4 sidecar or proxy. */
  customBindHost?: string;
  /** Externally reachable HTTPS origin for Gateway callback routes; HTTP only on loopback. */
  publicOrigin?: string;
  controlUi?: GatewayControlUiConfig;
  cliAgents?: GatewayCliAgentsConfig;
  terminal?: GatewayTerminalConfig;
  auth?: GatewayAuthConfig;
  /** Optional profile-bound operator roles; omitted preserves legacy authorization. */
  roles?: GatewayOperatorRolesConfig;
  tailscale?: GatewayTailscaleConfig;
  remote?: GatewayRemoteConfig;
  reload?: GatewayReloadConfig;
  tls?: GatewayTlsConfig;
  http?: GatewayHttpConfig;
  push?: GatewayPushConfig;
  nodes?: GatewayNodesConfig;
  /**
   * IPs of trusted reverse proxies (e.g. Traefik, nginx). When a connection
   * arrives from one of these IPs, the Gateway trusts `x-forwarded-for`
   * to determine the client IP for local pairing and HTTP checks.
   */
  trustedProxies?: string[];
  /**
   * Allow `x-real-ip` as a fallback only when `x-forwarded-for` is missing.
   * Default: false (safer fail-closed behavior).
   */
  allowRealIpFallback?: boolean;
  /** Tool access restrictions for HTTP /tools/invoke endpoint. */
  tools?: GatewayToolsConfig;
};
