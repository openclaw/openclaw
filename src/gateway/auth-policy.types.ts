import type { ResolvedGatewayAuth } from "./auth-resolve.js";
import type { GatewayWsBrowserOrigin } from "./server/client-identity-types.js";
import type { GatewayDelegation } from "./trusted-proxy-delegation.js";

export type GatewayAuthMethod =
  | "none"
  | "token"
  | "password"
  | "tailscale"
  | "device-token"
  | "bootstrap-token"
  | "trusted-proxy"
  | "remote-ingress";

export type GatewayAuthPolicy = Readonly<{
  /** Transport admission policy; changes require a fresh handshake. */
  generation: string;
  /** The original principal's access, independent of transport admission. */
  grantGeneration: string;
  role?: string;
  authMethod?: GatewayAuthMethod;
  /** Fixed startup mode attested by the auth resolver, independent of file-mode edits. */
  authModeOverride?: ResolvedGatewayAuth["mode"];
  /** Only operator WebSocket admission consumes identity grants. */
  verifiedIdentity?: string;
  delegation?: GatewayDelegation;
  /** Handshake-attested origin facts remain authoritative after transport retirement. */
  browserOrigin?: Readonly<GatewayWsBrowserOrigin>;
}>;

/** Authentication evidence retained in memory independently of durable-source bounds. */
export type GatewayAuthPolicyFacts = Readonly<
  Omit<GatewayAuthPolicy, "generation" | "browserOrigin"> & {
    fallbackCredentialGeneration?: string;
  }
>;
