import { createHash } from "node:crypto";
import type { GatewayTrustedProxyConfig } from "../../config/types.gateway.js";
import type { ResolvedGatewayAuth } from "../auth.js";

function resolveSharedSecret(
  auth: ResolvedGatewayAuth,
): { mode: "token" | "password"; secret: string } | null {
  // trim() is only a blank-value guard; generation must hash the exact raw secret bytes.
  if (auth.mode === "token" && typeof auth.token === "string" && auth.token.trim().length > 0) {
    return { mode: "token", secret: auth.token };
  }
  if (
    auth.mode === "password" &&
    typeof auth.password === "string" &&
    auth.password.trim().length > 0
  ) {
    return { mode: "password", secret: auth.password };
  }
  return null;
}

function normalizeTrustedProxyConfig(trustedProxy: GatewayTrustedProxyConfig | undefined): {
  userHeader: string | undefined;
  requiredHeaders: string[];
  allowUsers: string[];
  allowLoopback: boolean | undefined;
} {
  return {
    userHeader: trustedProxy?.userHeader,
    // Sort unordered policy arrays so equivalent config files do not force a
    // shared-gateway-auth generation rollover.
    requiredHeaders: [...(trustedProxy?.requiredHeaders ?? [])].toSorted(),
    allowUsers: [...(trustedProxy?.allowUsers ?? [])].toSorted(),
    allowLoopback: trustedProxy?.allowLoopback,
  };
}

/** Returns the stable generation key used to invalidate shared-auth websocket sessions. */
export function resolveSharedGatewaySessionGeneration(
  auth: ResolvedGatewayAuth,
  trustedProxies?: readonly string[],
): string | undefined {
  const shared = resolveSharedSecret(auth);
  if (shared) {
    // Include the mode separator so identical token/password bytes cannot share
    // a generation across different auth modes.
    return createHash("sha256")
      .update(`${shared.mode}\u0000${shared.secret}`, "utf8")
      .digest("base64url");
  }
  if (auth.mode === "trusted-proxy") {
    // Trusted-proxy sessions depend on proxy policy rather than a secret value;
    // include both header rules and trusted CIDRs so policy changes eject clients.
    return createHash("sha256")
      .update(
        JSON.stringify({
          mode: auth.mode,
          trustedProxy: normalizeTrustedProxyConfig(auth.trustedProxy),
          trustedProxies: [...(trustedProxies ?? [])].toSorted(),
        }),
        "utf8",
      )
      .digest("base64url");
  }
  return undefined;
}
