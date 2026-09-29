import type { GatewayAuthResult } from "./auth.js";
import type { GatewayWsBrowserOrigin } from "./server/client-identity-types.js";

export type GatewayAuthPolicy = Readonly<{
  /** Transport admission policy; changes require a fresh handshake. */
  generation: string;
  /** The original principal's access, independent of transport admission. */
  grantGeneration: string;
  role?: string;
  authMethod?: GatewayAuthResult["method"];
  /** Only operator WebSocket admission consumes identity grants. */
  verifiedIdentity?: string;
  /** Handshake-attested origin facts remain authoritative after transport retirement. */
  browserOrigin?: Readonly<GatewayWsBrowserOrigin>;
}>;
