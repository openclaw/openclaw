import type { UserProfileIdentity } from "../../state/user-profiles.types.js";

/** Server-attested identity facts shared by RPC and transport client records. */
export type GatewayWsBrowserOrigin = {
  requestHost?: string;
  origin?: string;
  isLocalClient?: boolean;
};

export type PreparedSessionProfile = UserProfileIdentity;
