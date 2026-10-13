// WebSocket shared-session generation hashes gateway auth inputs so clients can detect credential rotation.
import { sha256Base64Url } from "../../infra/crypto-digest.js";
import type { ResolvedGatewayAuth } from "../auth.js";

export function resolveSharedGatewaySessionGeneration(
  auth: ResolvedGatewayAuth,
  trustedProxies?: readonly string[],
): string | undefined {
  const secret = auth.mode === "token" || auth.mode === "password" ? auth[auth.mode] : undefined;
  // trim() only rejects blank credentials; durable generations retain the exact secret bytes.
  if (typeof secret === "string" && secret.trim().length > 0) {
    return sha256Base64Url(`${auth.mode}\u0000${secret}`);
  }
  if (auth.mode === "trusted-proxy") {
    return sha256Base64Url(
      JSON.stringify({
        mode: auth.mode,
        trustedProxy: {
          userHeader: auth.trustedProxy?.userHeader,
          requiredHeaders: [...(auth.trustedProxy?.requiredHeaders ?? [])].toSorted(),
          allowUsers: [...(auth.trustedProxy?.allowUsers ?? [])].toSorted(),
          allowLoopback: auth.trustedProxy?.allowLoopback,
        },
        trustedProxies: [...(trustedProxies ?? [])].toSorted(),
      }),
    );
  }
  return undefined;
}
