// Gateway known-weak credential guard.
// Rejects active shared-secret placeholders before the gateway starts.
import { isRedactedSecretValue } from "../config/redact-sentinel.js";
import type { ResolvedGatewayAuth } from "./auth-resolve.js";

const KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS = [
  "change-me-to-a-long-random-token",
  "change-me-now",
] as const;

const KNOWN_WEAK_GATEWAY_PASSWORD_PLACEHOLDERS = ["change-me-to-a-strong-password"] as const;

/**
 * Placeholder credentials that have ever shipped in `.env.example` or been
 * used as copy-paste examples in onboarding docs. If any of these ever
 * becomes the resolved gateway credential, reject it. The operator almost
 * certainly copied an example file verbatim without replacing the sentinel,
 * which would otherwise leave the gateway protected by a publicly-known
 * credential.
 */
const KNOWN_WEAK_GATEWAY_TOKENS: ReadonlySet<string> = new Set(
  KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS,
);

const KNOWN_WEAK_GATEWAY_PASSWORDS: ReadonlySet<string> = new Set(
  KNOWN_WEAK_GATEWAY_PASSWORD_PLACEHOLDERS,
);

/** Known non-secret values left by blank input or JavaScript string coercion. */
export function isInvalidGatewaySecret(value: unknown): boolean {
  return typeof value === "string" && ["", "undefined", "null"].includes(value.trim());
}

/** Optional proxy passwords remain diagnosable without owning proxy startup. */
export function getTrustedProxyPasswordRedactionWarning(
  auth: Pick<ResolvedGatewayAuth, "mode" | "password">,
): string | undefined {
  if (auth.mode !== "trusted-proxy" || !isRedactedSecretValue(auth.password)) {
    return undefined;
  }
  return "Gateway optional password is a known redaction sentinel. Trusted-proxy authentication remains available, but local password fallback is unavailable. Replace or remove gateway.auth.password / OPENCLAW_GATEWAY_PASSWORD and restart the Gateway.";
}

export function assertGatewayAuthNotKnownWeak(
  auth: ResolvedGatewayAuth,
  rawToken?: unknown,
  rawPassword?: unknown,
): void {
  if (auth.mode !== "token" && auth.mode !== "password") {
    return;
  }
  const credentialKind = auth.mode;
  if (
    isRedactedSecretValue(
      auth[credentialKind] ?? (credentialKind === "token" ? rawToken : rawPassword),
    )
  ) {
    throw new Error(
      `Gateway auth ${credentialKind} is a known redaction sentinel, not a credential. ` +
        (credentialKind === "password"
          ? "Replace gateway.auth.password, OPENCLAW_GATEWAY_PASSWORD, or its external secret source with a real password, then restart the Gateway."
          : "Run `openclaw doctor --fix` to repair the Gateway token or replace the external secret, then restart and re-pair devices."),
    );
  }
  if (auth.mode === "token") {
    // Token/password checks stay separate because auth mode is exclusive and
    // error text should name the credential the operator must rotate.
    const token = auth.token ?? rawToken;
    if (
      isInvalidGatewaySecret(token) ||
      (typeof token === "string" && KNOWN_WEAK_GATEWAY_TOKENS.has(token.trim()))
    ) {
      throw new Error(
        "Invalid config: gateway auth token is blank, a published example placeholder, or the literal string undefined/null. " +
          "Generate a real secret (for example, `openssl rand -hex 32`) and update gateway.auth.token or its external source. " +
          "For blank or undefined/null inline tokens, `openclaw doctor --fix --generate-gateway-token` can generate one.",
      );
    }
    return;
  }
  if (auth.mode === "password") {
    const password = auth.password ?? rawPassword;
    if (
      isInvalidGatewaySecret(password) ||
      (typeof password === "string" && KNOWN_WEAK_GATEWAY_PASSWORDS.has(password.trim()))
    ) {
      throw new Error(
        "Invalid config: gateway auth password is blank, a published example placeholder, or the literal string undefined/null. " +
          "Generate a real secret (for example, `openssl rand -hex 32`) and set OPENCLAW_GATEWAY_PASSWORD " +
          "or gateway.auth.password (or its external source) before starting the gateway.",
      );
    }
  }
}
