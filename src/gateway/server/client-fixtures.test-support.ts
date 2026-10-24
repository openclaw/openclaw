import type { ConnectParams } from "../../../packages/gateway-protocol/src/schema/frames.js";
import type { GatewayAuthenticatedUserProfile } from "./client-identity-types.js";

export function gatewayProfile(
  profileId: string,
  displayName: string | null = null,
  updatedAt = 1,
): Pick<GatewayAuthenticatedUserProfile, "profileId" | "displayName" | "hasAvatar" | "updatedAt"> {
  return { profileId, displayName, hasAvatar: false, updatedAt };
}

export const dispatchProfile = (
  profileId: string,
  overrides: Partial<GatewayAuthenticatedUserProfile> = {},
) => ({
  profileId,
  displayName: null,
  avatarRevision: "1",
  hasAvatar: false,
  updatedAt: 1,
  ...overrides,
});

export function gatewayConnect(
  scopes: string[] | undefined,
  clientOverrides: Partial<ConnectParams["client"]> = {},
  protocol = 1,
  role = "operator",
): ConnectParams {
  return {
    minProtocol: protocol,
    maxProtocol: protocol,
    client: {
      id: "openclaw-control-ui",
      version: "test",
      platform: "test",
      mode: "webchat",
      ...clientOverrides,
    },
    role,
    scopes,
  };
}
