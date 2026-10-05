import type { z } from "zod";
import type { SecretInput } from "./types.secrets.js";
import type { GatewayConfigSchema } from "./zod-schema.gateway.js";
import type { OpenClawSchemaShape } from "./zod-schema.root-shape.js";
import type { TalkSchema } from "./zod-schema.root-support.js";

type GatewayConfigInput = NonNullable<z.input<typeof GatewayConfigSchema>>;
type TalkConfigInput = z.input<typeof TalkSchema>;

/** Gateway bind-address policy for local server startup. */
export type GatewayBindMode = NonNullable<GatewayConfigInput["bind"]>;

export type GatewayTlsConfig = NonNullable<GatewayConfigInput["tls"]>;

export type DiscoveryConfig = NonNullable<z.input<typeof OpenClawSchemaShape.discovery>>;
export type MdnsDiscoveryConfig = NonNullable<DiscoveryConfig["mdns"]>;
export type MdnsDiscoveryMode = NonNullable<MdnsDiscoveryConfig["mode"]>;

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
  github?: { host?: string; token?: SecretInput };
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

/** Operator-provisioned private HTTPS wildcard portal ingress. */
export type GatewayPortalIngressConfig = NonNullable<
  NonNullable<GatewayConfigInput["portals"]>["ingress"]
>;

export type GatewayRemoteConfig = NonNullable<GatewayConfigInput["remote"]>;

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

export type GatewayHttpResponsesConfig = NonNullable<GatewayHttpEndpointsConfigInput["responses"]>;

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

/** Closed session, sandbox, agent, model, and operator-scope policy for one named team role. */
export type GatewayOperatorRoleDefinition = NonNullable<
  GatewayConfigInput["roles"]
>["definitions"][string];

/** Optional named operator-role policies for Gateway deployments shared by a team. */
export type GatewayOperatorRolesConfig = Omit<
  NonNullable<GatewayConfigInput["roles"]>,
  "default"
> & {
  /** Required default for profiles without a valid explicit or GitHub login assignment. */
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
