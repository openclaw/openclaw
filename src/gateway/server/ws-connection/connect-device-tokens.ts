import { ensureDeviceToken } from "../../../infra/device-pairing-tokens.js";
import { resolveBootstrapProfileScopesForRole } from "../../../shared/device-bootstrap-profile.js";
import type {
  AuthenticatedGatewayConnect,
  DeviceAuthorizedGatewayConnect,
} from "./message-handler-types.js";

export async function issueGatewayConnectDeviceTokens(params: {
  state: AuthenticatedGatewayConnect;
  scopes: string[];
  hasApprovedDeviceBaseline: boolean;
  isIssuanceCurrent: () => boolean;
}): Promise<Pick<DeviceAuthorizedGatewayConnect, "deviceToken" | "bootstrapDeviceTokens">> {
  const { state, scopes, hasApprovedDeviceBaseline } = params;
  const {
    role,
    device,
    isBrowserOperatorUi,
    isWebchat,
    trustedProxyAuthOk,
    sessionUsesSharedGatewayAuth,
    sessionSharedGatewaySessionGeneration,
    deviceTokenSharedGatewaySessionGeneration,
    handoffBootstrapProfile,
  } = state;
  const sharedGatewayAuthIssuer =
    sessionSharedGatewaySessionGeneration &&
    (deviceTokenSharedGatewaySessionGeneration !== undefined ||
      (sessionUsesSharedGatewayAuth && (isBrowserOperatorUi || isWebchat)))
      ? {
          kind: "shared-gateway-auth" as const,
          generation: sessionSharedGatewaySessionGeneration,
        }
      : undefined;
  const nodePrincipal = role === "node" ? state.authResult.openclawId : undefined;
  // Manual re-pairing stays manual, but its issued role still belongs to this live listing.
  const issuedDeviceGrant =
    !trustedProxyAuthOk && device && hasApprovedDeviceBaseline
      ? await ensureDeviceToken({
          deviceId: device.id,
          role,
          scopes,
          issuer: sharedGatewayAuthIssuer,
          approval:
            nodePrincipal?.kind === "node" && nodePrincipal.authority
              ? {
                  approvedVia: "openclaw-id-node",
                  peerKey: nodePrincipal.peerKey,
                  authority: nodePrincipal.authority,
                }
              : undefined,
          isIssuanceCurrent: params.isIssuanceCurrent,
        })
      : null;
  const bootstrapDeviceTokens: DeviceAuthorizedGatewayConnect["bootstrapDeviceTokens"] = [];
  if (issuedDeviceGrant) {
    bootstrapDeviceTokens.push({
      deviceToken: issuedDeviceGrant.token,
      role: issuedDeviceGrant.role,
      scopes: issuedDeviceGrant.scopes,
      issuedAtMs: issuedDeviceGrant.rotatedAtMs ?? issuedDeviceGrant.createdAtMs,
    });
  }
  if (device && handoffBootstrapProfile) {
    for (const bootstrapRole of handoffBootstrapProfile.roles) {
      if (bootstrapDeviceTokens.some((entry) => entry.role === bootstrapRole)) {
        continue;
      }
      // Extra hello-ok handoff tokens are only emitted for the approved
      // setup-code profile. Operator scopes are filtered through the closed
      // mobile allowlist selected when the setup code was issued.
      const bootstrapRoleScopes =
        bootstrapRole === "operator"
          ? resolveBootstrapProfileScopesForRole(
              bootstrapRole,
              handoffBootstrapProfile.scopes,
              handoffBootstrapProfile.purpose,
            )
          : [];
      const extraToken = await ensureDeviceToken({
        deviceId: device.id,
        role: bootstrapRole,
        scopes: bootstrapRoleScopes,
        isIssuanceCurrent: params.isIssuanceCurrent,
      });
      if (!extraToken) {
        continue;
      }
      bootstrapDeviceTokens.push({
        deviceToken: extraToken.token,
        role: extraToken.role,
        scopes: extraToken.scopes,
        issuedAtMs: extraToken.rotatedAtMs ?? extraToken.createdAtMs,
      });
    }
  }
  return { deviceToken: issuedDeviceGrant, bootstrapDeviceTokens };
}
