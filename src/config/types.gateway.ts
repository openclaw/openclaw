import type { z } from "zod";
// Defines gateway runtime and networking configuration types.
import type { SecretInput } from "./types.secrets.js";
import type { GatewayConfigSchema } from "./zod-schema.gateway.js";
import type { TalkSchema } from "./zod-schema.root-support.js";

type GatewayConfigInput = NonNullable<z.input<typeof GatewayConfigSchema>>;
type TalkConfigInput = z.input<typeof TalkSchema>;

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

export type TalkProviderConfig = NonNullable<TalkConfigInput["providers"]>[string];
export type TalkRealtimeConfig = NonNullable<TalkConfigInput["realtime"]>;

export type ResolvedTalkConfig = {
  /** Active Talk TTS provider resolved from the current config payload. */
  provider: string;
  /** Provider config for the active Talk provider. */
  config: TalkProviderConfig;
};

export type TalkConfig = TalkConfigInput;

export type TalkConfigResponse = TalkConfig & {
  /** Canonical active Talk payload for clients. */
  resolved?: ResolvedTalkConfig;
};

export type GatewayControlUiConfig = Omit<
  NonNullable<GatewayConfigInput["controlUi"]>,
  "github" | "dangerouslyDisableDeviceAuth"
> & {
  /** @deprecated Doctor-only legacy input. */
  chatMessageMaxWidth?: string;
  /**
   * @deprecated Upgrade-only transport input. Retained so releases that shipped
   * this break-glass flag can migrate an unpaired browser safely.
   */
  dangerouslyDisableDeviceAuth?: boolean;
  github?: { token?: SecretInput };
};

/** Gateway authentication strategy for WebSocket and HTTP clients. */
export type GatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";

/**
 * Configuration for trusted reverse proxy authentication.
 * Used when Clawdbot runs behind an identity-aware proxy (Pomerium, Caddy + OAuth, etc.)
 * that handles authentication and passes user identity via headers.
 */
export type GatewayTrustedProxyConfig = NonNullable<GatewayAuthConfig["trustedProxy"]>;

export type GatewayAuthConfig = Omit<
  NonNullable<GatewayConfigInput["auth"]>,
  "token" | "password"
> & {
  token?: SecretInput;
  password?: SecretInput;
};

export type GatewayAuthRateLimitConfig = NonNullable<GatewayAuthConfig["rateLimit"]>;

/** Tailscale exposure mode for gateway HTTP/WebSocket surfaces. */
export type GatewayTailscaleMode = "off" | "serve" | "funnel";

export type GatewayTailscaleConfig = Omit<
  NonNullable<GatewayConfigInput["tailscale"]>,
  "preserveFunnel"
> & {
  /** @deprecated Migrate to `mode="funnel"`, which uses managed ingress. */
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
export type GatewayTerminalConfig = NonNullable<GatewayConfigInput["terminal"]>;

/** External CLI session targets in the Control UI. */
export type GatewayCliAgentsConfig = NonNullable<GatewayConfigInput["cliAgents"]>;

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

export type GatewayNodePairingConfig = NonNullable<
  NonNullable<GatewayConfigInput["nodes"]>["pairing"]
>;

export type GatewayNodesConfig = NonNullable<GatewayConfigInput["nodes"]> & {
  /** @deprecated Doctor-only legacy input. */
  skills?: { enabled?: boolean };
  /** @deprecated Doctor-only legacy input. */
  allowCommands?: string[];
  /** @deprecated Doctor-only legacy input. */
  denyCommands?: string[];
};

export type GatewayToolsConfig = NonNullable<GatewayConfigInput["tools"]>;

/** Closed session, sandbox, agent, and operator-scope policy for one named team role. */
export type GatewayOperatorRoleDefinition = NonNullable<
  GatewayConfigInput["roles"]
>["definitions"][string];

/** Optional named operator-role policies for Gateway deployments shared by a team. */
export type GatewayOperatorRolesConfig = Omit<
  NonNullable<GatewayConfigInput["roles"]>,
  "default"
> & {
  /** Required validated default for profiles without a valid assigned role. */
  default?: string;
};

export type GatewayConfig = Omit<
  GatewayConfigInput,
  "controlUi" | "nodes" | "roles" | "reload" | "auth" | "tailscale"
> & {
  auth?: GatewayAuthConfig;
  controlUi?: GatewayControlUiConfig;
  nodes?: GatewayNodesConfig;
  roles?: GatewayOperatorRolesConfig;
  reload?: GatewayReloadConfig;
  tailscale?: GatewayTailscaleConfig;
};
