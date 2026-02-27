export type GatewayBindMode = "auto" | "lan" | "loopback" | "custom" | "tailnet";

export type GatewayTlsConfig = {
  /** Enable TLS for the gateway server. */
  enabled?: boolean;
  /** Auto-generate a self-signed cert if cert/key are missing (default: true). */
  autoGenerate?: boolean;
  /** PEM certificate path for the gateway server. */
  certPath?: string;
  /** PEM private key path for the gateway server. */
  keyPath?: string;
  /** Optional PEM CA bundle for TLS clients (mTLS or custom roots). */
  caPath?: string;
};

export type WideAreaDiscoveryConfig = {
  enabled?: boolean;
  /** Optional unicast DNS-SD domain (e.g. "bot.internal"). */
  domain?: string;
};

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
  wideArea?: WideAreaDiscoveryConfig;
  mdns?: MdnsDiscoveryConfig;
};

export type CanvasHostConfig = {
  enabled?: boolean;
  /** Directory to serve (default: ~/.hanzo/bot/workspace/canvas). */
  root?: string;
  /** HTTP port to listen on (default: 18793). */
  port?: number;
  /** Enable live-reload file watching + WS reloads (default: true). */
  liveReload?: boolean;
};

export type TalkConfig = {
  /** Default ElevenLabs voice ID for Talk mode. */
  voiceId?: string;
  /** Optional voice name -> ElevenLabs voice ID map. */
  voiceAliases?: Record<string, string>;
  /** Default ElevenLabs model ID for Talk mode. */
  modelId?: string;
  /** Default ElevenLabs output format (e.g. mp3_44100_128). */
  outputFormat?: string;
  /** ElevenLabs API key (optional; falls back to ELEVENLABS_API_KEY). */
  apiKey?: string;
  /** Stop speaking when user starts talking (default: true). */
  interruptOnSpeech?: boolean;
};

export type GatewayControlUiConfig = {
  /** If false, the Gateway will not serve the Control UI (default /). */
  enabled?: boolean;
  /** Optional base path prefix for the Control UI (e.g. "/bot"). */
  basePath?: string;
  /** Optional filesystem root for Control UI assets (defaults to dist/control-ui). */
  root?: string;
  /** Allowed browser origins for Control UI/WebChat websocket connections. */
  allowedOrigins?: string[];
  /** Allow token-only auth over insecure HTTP (default: false). */
  allowInsecureAuth?: boolean;
};

export type GatewayAuthMode = "token" | "password" | "trusted-proxy" | "iam";

/**
 * Configuration for IAM (OIDC) authentication.
 * Used when Bot connects to an IAM server (e.g. iam.hanzo.ai) for
 * organization-based auth with JWT tokens.
 */
export type GatewayIamConfig = {
  /** IAM server URL (e.g. "https://iam.hanzo.ai"). */
  serverUrl: string;
  /** OAuth2 client ID registered with the IAM server. */
  clientId: string;
  /** OAuth2 client secret (optional; required for confidential clients). */
  clientSecret?: string;
  /** Default org name/slug for login redirects. */
  orgName?: string;
  /** Casdoor application name (used for signup URL). */
  appName?: string;
  /** OAuth2 scopes to request (defaults to ["openid", "profile", "email"]). */
  scopes?: string[];
  /**
   * Email addresses with super-admin privileges.
   * Super admins bypass billing checks and can credit their own account for testing.
   */
  superAdmins?: string[];
};

/**
 * Configuration for trusted reverse proxy authentication.
 * Used when Bot runs behind an identity-aware proxy (Pomerium, Caddy + OAuth, etc.)
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
};

export type GatewayAuthConfig = {
  /** Authentication mode for Gateway connections. Defaults to token when set. */
  mode?: GatewayAuthMode;
  /** Shared token for token mode (stored locally for CLI auth). */
  token?: string;
  /** Shared password for password mode (consider env instead). */
  password?: string;
  /** Allow Tailscale identity headers when serve mode is enabled. */
  allowTailscale?: boolean;
  /** Rate-limit configuration for failed authentication attempts. */
  rateLimit?: GatewayAuthRateLimitConfig;
  /**
   * Configuration for trusted-proxy auth mode.
   * Required when mode is "trusted-proxy".
   */
  trustedProxy?: GatewayTrustedProxyConfig;
  /**
   * Configuration for IAM (OIDC) auth mode.
   * Required when mode is "iam".
   */
  iam?: GatewayIamConfig;
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

export type GatewayTailscaleMode = "off" | "serve" | "funnel";

export type GatewayTailscaleConfig = {
  /** Tailscale exposure mode for the Gateway control UI. */
  mode?: GatewayTailscaleMode;
  /** Reset serve/funnel configuration on shutdown. */
  resetOnExit?: boolean;
};

export type GatewayRemoteConfig = {
  /** Remote Gateway WebSocket URL (ws:// or wss://). */
  url?: string;
  /** Transport for macOS remote connections (ssh tunnel or direct WS). */
  transport?: "ssh" | "direct";
  /** Token for remote auth (when the gateway requires token auth). */
  token?: string;
  /** Password for remote auth (when the gateway requires password auth). */
  password?: string;
  /** Expected TLS certificate fingerprint (sha256) for remote gateways. */
  tlsFingerprint?: string;
  /** SSH target for tunneling remote Gateway (user@host). */
  sshTarget?: string;
  /** SSH identity file path for tunneling remote Gateway. */
  sshIdentity?: string;
};

export type GatewayReloadMode = "off" | "restart" | "hot" | "hybrid";

export type GatewayReloadConfig = {
  /** Reload strategy for config changes (default: hybrid). */
  mode?: GatewayReloadMode;
  /** Debounce window for config reloads (ms). Default: 300. */
  debounceMs?: number;
};

export type GatewayHttpChatCompletionsConfig = {
  /**
   * If false, the Gateway will not serve `POST /v1/chat/completions`.
   * Default: false when absent.
   */
  enabled?: boolean;
};

export type GatewayHttpResponsesConfig = {
  /**
   * If false, the Gateway will not serve `POST /v1/responses` (OpenResponses API).
   * Default: false when absent.
   */
  enabled?: boolean;
  /**
   * Max request body size in bytes for `/v1/responses`.
   * Default: 20MB.
   */
  maxBodyBytes?: number;
  /**
   * Max number of URL-based `input_file` + `input_image` parts per request.
   * Default: 8.
   */
  maxUrlParts?: number;
  /** File inputs (input_file). */
  files?: GatewayHttpResponsesFilesConfig;
  /** Image inputs (input_image). */
  images?: GatewayHttpResponsesImagesConfig;
};

export type GatewayHttpResponsesFilesConfig = {
  /** Allow URL fetches for input_file. Default: true. */
  allowUrl?: boolean;
  /**
   * Optional hostname allowlist for URL fetches.
   * Supports exact hosts and `*.example.com` wildcards.
   */
  urlAllowlist?: string[];
  /** Allowed MIME types (case-insensitive). */
  allowedMimes?: string[];
  /** Max bytes per file. Default: 5MB. */
  maxBytes?: number;
  /** Max decoded characters per file. Default: 200k. */
  maxChars?: number;
  /** Max redirects when fetching a URL. Default: 3. */
  maxRedirects?: number;
  /** Fetch timeout in ms. Default: 10s. */
  timeoutMs?: number;
  /** PDF handling (application/pdf). */
  pdf?: GatewayHttpResponsesPdfConfig;
};

export type GatewayHttpResponsesPdfConfig = {
  /** Max pages to parse/render. Default: 4. */
  maxPages?: number;
  /** Max pixels per rendered page. Default: 4M. */
  maxPixels?: number;
  /** Minimum extracted text length to skip rasterization. Default: 200 chars. */
  minTextChars?: number;
};

export type GatewayHttpResponsesImagesConfig = {
  /** Allow URL fetches for input_image. Default: true. */
  allowUrl?: boolean;
  /**
   * Optional hostname allowlist for URL fetches.
   * Supports exact hosts and `*.example.com` wildcards.
   */
  urlAllowlist?: string[];
  /** Allowed MIME types (case-insensitive). */
  allowedMimes?: string[];
  /** Max bytes per image. Default: 10MB. */
  maxBytes?: number;
  /** Max redirects when fetching a URL. Default: 3. */
  maxRedirects?: number;
  /** Fetch timeout in ms. Default: 10s. */
  timeoutMs?: number;
};

export type GatewayHttpEndpointsConfig = {
  chatCompletions?: GatewayHttpChatCompletionsConfig;
  responses?: GatewayHttpResponsesConfig;
};

export type GatewayHttpConfig = {
  endpoints?: GatewayHttpEndpointsConfig;
};

/**
 * Per-node billing mode.
 * - global: use the owner's account balance (default)
 * - dedicated: node has its own credit budget
 * - local: no cloud billing, node uses local API keys
 * - shared: node participates in marketplace (buyer pays, seller earns)
 */
export type NodeBillingMode = "global" | "dedicated" | "local" | "shared";

/** Per-node billing configuration. */
export type NodeBillingConfig = {
  /** How this node is billed (default: "global"). */
  mode?: NodeBillingMode;
  /** Budget in cents for dedicated mode. When spent reaches budget, requests are blocked. */
  budgetCents?: number;
  /** Running spent total in cents (tracked by gateway, persisted across restarts). */
  spentCents?: number;
};

export type GatewayNodesConfig = {
  /** Browser routing policy for node-hosted browser proxies. */
  browser?: {
    /** Routing mode (default: auto). */
    mode?: "auto" | "manual" | "off";
    /** Pin to a specific node id/name (optional). */
    node?: string;
  };
  /** Additional node.invoke commands to allow on the gateway. */
  allowCommands?: string[];
  /** Commands to deny even if they appear in the defaults or node claims. */
  denyCommands?: string[];
  /** Per-node billing configuration (keyed by nodeId). */
  billing?: Record<string, NodeBillingConfig>;
};

export type GatewayToolsConfig = {
  /** Tools to deny via gateway HTTP /tools/invoke (extends defaults). */
  deny?: string[];
  /** Tools to explicitly allow (removes from default deny list). */
  allow?: string[];
};

export type GatewayTunnelProvider = "cloudflared" | "ngrok" | "localxpose" | "zrok" | "none";

export type GatewayTunnelConfig = {
  /**
   * Tunnel provider to expose the gateway to the internet.
   * - cloudflared: Cloudflare Tunnel (free, no auth token required for quick tunnels)
   * - ngrok: ngrok tunnel (free tier available, auth token recommended)
   * - localxpose: LocalXpose tunnel (requires auth token)
   * - zrok: zrok tunnel (requires auth token)
   * - none: Disable tunneling (default)
   */
  provider?: GatewayTunnelProvider;
  /** Provider API key / auth token (required for ngrok, localxpose, zrok). */
  authToken?: string;
  /** Custom domain for the tunnel (paid feature on most providers). */
  domain?: string;
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
   * - lan: 0.0.0.0 (all interfaces, no fallback)
   * - loopback: 127.0.0.1 (local-only)
   * - tailnet: Tailnet IPv4 if available (100.64.0.0/10), else loopback
   * - custom: User-specified IP, fallback to 0.0.0.0 if unavailable (requires customBindHost)
   * Default: loopback (127.0.0.1).
   */
  bind?: GatewayBindMode;
  /** Custom IP address for bind="custom" mode. Fallback: 0.0.0.0. */
  customBindHost?: string;
  controlUi?: GatewayControlUiConfig;
  auth?: GatewayAuthConfig;
  tailscale?: GatewayTailscaleConfig;
  tunnel?: GatewayTunnelConfig;
  remote?: GatewayRemoteConfig;
  reload?: GatewayReloadConfig;
  tls?: GatewayTlsConfig;
  http?: GatewayHttpConfig;
  nodes?: GatewayNodesConfig;
  /**
   * IPs of trusted reverse proxies (e.g. Traefik, nginx). When a connection
   * arrives from one of these IPs, the Gateway trusts `x-forwarded-for` (or
   * `x-real-ip`) to determine the client IP for local pairing and HTTP checks.
   */
  trustedProxies?: string[];
  /** Tool access restrictions for HTTP /tools/invoke endpoint. */
  tools?: GatewayToolsConfig;
  /** P2P marketplace configuration for idle compute sharing. */
  marketplace?: MarketplaceConfig;
};

/** Marketplace (P2P idle compute sharing) configuration. */
export type MarketplaceConfig = {
  /** Whether the marketplace is enabled on this gateway. Default: false. */
  enabled?: boolean;
  /** When true, marketplace returns "coming soon" instead of processing requests. */
  comingSoon?: boolean;
  /** Platform fee percentage taken from each transaction (0-100). Default: 20. */
  platformFeePct?: number;
  /**
   * Marketplace price as a fraction of Anthropic list price (0-1). Default: 0.6.
   * e.g. 0.6 = buyer pays 60% of list price.
   */
  priceFraction?: number;
  /** Minimum payout threshold in cents. Default: 1000 ($10). */
  minPayoutCents?: number;
  /** Bonus percentage for $AI token payouts. Default: 10. */
  aiTokenBonusPct?: number;
  /** On-chain $AI token settlement configuration. */
  chain?: MarketplaceChainConfig;
};

/** On-chain $AI token settlement for marketplace payouts. */
export type MarketplaceChainConfig = {
  /** EVM chain ID. Default: 36963 (Hanzo). */
  chainId?: number;
  /** JSON-RPC endpoint for the settlement chain. */
  rpcUrl?: string;
  /** $AI token ERC-20 contract address (checksummed hex). */
  tokenContract?: string;
  /** Treasury/payout wallet address (hex). Signs payout transfers. */
  treasuryAddress?: string;
  /** Treasury private key env var name. Default: "MARKETPLACE_TREASURY_KEY". */
  treasuryKeyEnv?: string;
};
