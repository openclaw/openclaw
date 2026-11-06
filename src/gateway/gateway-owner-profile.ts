import type { GatewayAuthResult } from "./auth.js";

/** Owner attribution never supplies a verified login or changes operator authority. */
export function shouldUseGatewayOwnerProfile(params: {
  role: string;
  authenticatedUserId?: string;
  authMethod: GatewayAuthResult["method"];
  rolesConfigured: boolean;
  /** An admitted OpenClaw ID owner device, which acts as the Gateway owner. */
  openclawIdOwner?: boolean;
}): boolean {
  return (
    params.role === "operator" &&
    !params.authenticatedUserId &&
    (!params.rolesConfigured ||
      params.authMethod === "token" ||
      params.authMethod === "password" ||
      params.openclawIdOwner === true)
  );
}
