import type { ResolvedGatewayAuth } from "./auth-resolve.js";
import type { GatewayAuthResult } from "./auth.js";
import type { GatewayWsBrowserOrigin } from "./server/client-identity-types.js";

export type GatewayAuthPolicy = Readonly<{
  /** Transport admission policy; changes require a fresh handshake. */
  generation: string;
  /** The original principal's access, independent of transport admission. */
  grantGeneration: string;
  role?: string;
  authMethod?: GatewayAuthResult["method"];
  /** Fixed startup mode attested by the auth resolver, independent of file-mode edits. */
  authModeOverride?: ResolvedGatewayAuth["mode"];
  /** Only operator WebSocket admission consumes identity grants. */
  verifiedIdentity?: string;
  /** Handshake-attested origin facts remain authoritative after transport retirement. */
  browserOrigin?: Readonly<GatewayWsBrowserOrigin>;
}>;
