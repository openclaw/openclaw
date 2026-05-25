import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { ResolvedGatewayAuth } from "./auth.js";

export type GatewayAuthSharedSecretLabel = "gateway auth token" | "gateway auth password";

type ActiveGatewaySharedSecret = {
  label: GatewayAuthSharedSecretLabel;
  value?: string;
};

function listActiveGatewaySharedSecrets(auth: ResolvedGatewayAuth): ActiveGatewaySharedSecret[] {
  if (auth.mode === "token") {
    return [{ label: "gateway auth token", value: auth.token }];
  }
  if (auth.mode === "password" || auth.mode === "trusted-proxy") {
    return [{ label: "gateway auth password", value: auth.password }];
  }
  return [];
}

export function findGatewayAuthLabelMatchingHooksToken(params: {
  hooksToken?: string;
  auth: ResolvedGatewayAuth;
}): GatewayAuthSharedSecretLabel | undefined {
  const hooksToken = normalizeOptionalString(params.hooksToken);
  if (!hooksToken) {
    return undefined;
  }
  return listActiveGatewaySharedSecrets(params.auth).find(
    (candidate) => normalizeOptionalString(candidate.value) === hooksToken,
  )?.label;
}
