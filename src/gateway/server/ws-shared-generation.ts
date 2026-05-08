import { createHash } from "node:crypto";
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

export function resolveSharedGatewaySessionGeneration(
  auth: ResolvedGatewayAuth,
): string | undefined {
  const shared = resolveSharedSecret(auth);
  if (!shared) {
    return undefined;
  }
  return createHash("sha256")
    .update(`${shared.mode}\u0000${shared.secret}`, "utf8")
    .digest("base64url");
}
