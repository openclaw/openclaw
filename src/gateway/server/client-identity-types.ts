import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { GatewayIngressPrincipal } from "../../plugins/gateway-ingress.types.js";
import type { UserProfileIdentity } from "../../state/user-profiles.types.js";
import type { GatewayOperatorAccessAuthority } from "../operator-access-policy.types.js";
import type { GatewayOperatorRoleActor } from "../operator-role-actor.js";

/** Server-attested identity facts shared by RPC and transport client records. */
export type GatewayAuthenticatedUserProfile = {
  profileId: string;
  displayName: string | null;
  avatarRevision: string;
  hasAvatar: boolean;
  updatedAt: number;
};

export type RemoteIngressPrincipalSnapshot = Readonly<{
  bindingId: string;
  authenticatedUserProfile: GatewayAuthenticatedUserProfile;
  preparedSessionProfile: UserProfileIdentity;
  operatorRoleActor: GatewayOperatorRoleActor;
  operatorRolePolicy?: GatewayOperatorRoleDefinition;
  operatorAccessAuthority?: GatewayOperatorAccessAuthority | null;
  scopes: string[];
  signal: AbortSignal;
  assertCurrent(): void;
}>;

/** Core-retained grant authority; browser headers cannot create this context. */
export type RemoteControlUiIngressContext = Readonly<{
  pluginId: string;
  audienceId: string;
  publicOrigin: string;
  sandboxOrigin: string;
  principal: GatewayIngressPrincipal;
  operatorScopeCeiling: readonly string[];
  resolvePrincipal(): RemoteIngressPrincipalSnapshot;
  frameAncestors: readonly string[];
  signal: AbortSignal;
  assertCurrent(): void;
}>;

export type GatewayWsBrowserOrigin = {
  requestHost?: string;
  origin?: string;
  isLocalClient?: boolean;
  remoteControlUiIngress?: RemoteControlUiIngressContext;
};
