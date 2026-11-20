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
  /** Live shared-auth generation; present whenever the gateway runs shared token/password auth. */
  requiredSharedGatewaySessionGeneration?: string;
}): Promise<Pick<DeviceAuthorizedGatewayConnect, "deviceToken" | "bootstrapDeviceTokens">> {
  const { state, scopes, hasApprovedDeviceBaseline, requiredSharedGatewaySessionGeneration } =
    params;
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
  const isBrowserRelated = isBrowserOperatorUi || isWebchat;
  const sessionBoundGeneration =
    sessionSharedGatewaySessionGeneration &&
    (deviceTokenSharedGatewaySessionGeneration !== undefined ||
      (sessionUsesSharedGatewayAuth && isBrowserRelated))
      ? sessionSharedGatewaySessionGeneration
      : undefined;
  // Browser tokens are verified against the live shared-auth generation on every
  // reconnect; one minted without an issuer is refused as legacy-browser-token.
  // A browser can reach this point without carrying the shared credential (a
  // QR/mobile setup code, or a bare device-key pairing approved on the gateway),
  // so bind those tokens to the live generation too instead of minting one the
  // gateway will reject after its next restart.
  const issuerGeneration =
    sessionBoundGeneration ??
    (isBrowserRelated ? requiredSharedGatewaySessionGeneration : undefined);
  const sharedGatewayAuthIssuer = issuerGeneration
    ? {
        kind: "shared-gateway-auth" as const,
        generation: issuerGeneration,
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
