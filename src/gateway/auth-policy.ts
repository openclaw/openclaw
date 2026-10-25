import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sha256Base64Url } from "../infra/crypto-digest.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import type { GatewayAuthPolicy } from "./auth-policy.types.js";
import { resolveGatewayAuthForConfig } from "./auth-resolve.js";
import { resolveIdentityOperatorScopes } from "./operator-identity-scopes.js";
import { isOperatorScope } from "./operator-scopes.js";
import { checkGatewayWsBrowserOrigin } from "./origin-check.js";

const policies = new WeakMap<
  OpenClawConfig,
  {
    global: string;
    identities: Map<string, GatewayAuthPolicy>;
    captured: WeakMap<object, GatewayAuthPolicy>;
  }
>();

/** Capture the grant principal together with its generation; null means no identity-derived scopes. */
export function captureGatewayAuthPolicy(
  config: OpenClawConfig,
  principal: Pick<
    GatewayAuthPolicy,
    "role" | "verifiedIdentity" | "authMethod" | "authModeOverride" | "browserOrigin"
  > | null,
): GatewayAuthPolicy {
  let cached = policies.get(config);
  // Only this config's issued, non-contextual policies can skip principal serialization.
  const captured = principal && cached?.captured.get(principal);
  if (captured) {
    return captured;
  }
  const verifiedIdentity = normalizeOptionalString(principal?.verifiedIdentity);
  const role = principal?.role;
  const authMethod = principal?.authMethod;
  const authModeOverride = principal?.authModeOverride;
  const browserOrigin = principal?.browserOrigin;
  // Contextual grants carry live service closures. Never retain them in config's
  // process-lived principal cache or share authority between matching audiences.
  const contextualIngress = browserOrigin?.remoteControlUiIngress !== undefined;
  if (!cached) {
    const gateway = config.gateway;
    const trustedProxy = gateway?.auth?.trustedProxy;
    cached = {
      global: stableStringify({
        // Named roles are enforced per profile, independently of transport admission.
        trustedProxies: gateway?.trustedProxies?.toSorted(),
        allowRealIpFallback: gateway?.allowRealIpFallback,
        allowTailscale: gateway?.auth?.allowTailscale,
        trustedProxy: trustedProxy && {
          ...trustedProxy,
          requiredHeaders: (trustedProxy.requiredHeaders ?? []).toSorted(),
          allowUsers: (trustedProxy.allowUsers ?? []).toSorted(),
        },
      }),
      identities: new Map(),
      captured: new WeakMap(),
    };
    policies.set(config, cached);
  }
  const principalKey = contextualIngress
    ? undefined
    : stableStringify([role, verifiedIdentity, authMethod, authModeOverride, browserOrigin]);
  let policy = principalKey === undefined ? undefined : cached.identities.get(principalKey);
  if (!policy) {
    const grant =
      role === "operator" && verifiedIdentity
        ? [
            ...new Set(
              resolveIdentityOperatorScopes(verifiedIdentity, config.gateway?.auth?.identityScopes),
            ),
          ].toSorted()
        : undefined;
    let methodEnabled: boolean | undefined;
    let proxyUserAllowed: boolean | undefined;
    let fallbackCredentialGeneration: string | undefined;
    if (
      authMethod === "trusted-proxy" ||
      authMethod === "tailscale" ||
      authMethod === "none" ||
      authMethod === "password"
    ) {
      const auth = resolveGatewayAuthForConfig({
        config,
        authOverride: authModeOverride ? { mode: authModeOverride } : undefined,
        tailscaleMode: config.gateway?.tailscale?.mode,
      });
      if (authMethod === "trusted-proxy") {
        methodEnabled = auth.mode === "trusted-proxy" && auth.trustedProxy !== undefined;
        const allowUsers = auth.trustedProxy?.allowUsers;
        proxyUserAllowed = Boolean(
          verifiedIdentity && (!allowUsers?.length || allowUsers.includes(verifiedIdentity)),
        );
      } else if (authMethod === "tailscale") {
        methodEnabled =
          auth.allowTailscale && auth.mode !== "trusted-proxy" && auth.mode !== "none";
      } else if (authMethod === "none") {
        methodEnabled = auth.mode === "none";
      } else if (auth.mode === "trusted-proxy") {
        // The proxy handshake generation does not include its local password fallback.
        methodEnabled = Boolean(auth.password);
        fallbackCredentialGeneration = auth.password ? sha256Base64Url(auth.password) : undefined;
      }
    }
    policy = Object.freeze({
      generation: cached.global,
      grantGeneration: stableStringify({
        grant,
        methodEnabled,
        proxyUserAllowed,
        fallbackCredentialGeneration,
        browserOriginAllowed: browserOrigin
          ? checkGatewayWsBrowserOrigin(browserOrigin, config).ok
          : undefined,
      }),
      role,
      authMethod,
      authModeOverride,
      verifiedIdentity,
      browserOrigin: browserOrigin && Object.freeze({ ...browserOrigin }),
    });
    if (principalKey !== undefined) {
      cached.identities.set(principalKey, policy);
      cached.captured.set(policy, policy);
    }
  }
  return policy;
}

/** Preserve persisted fingerprints while accepting equivalent identity-scope spellings. */
function areGatewayAuthGrantsEquivalent(
  previousGeneration: string,
  nextGeneration: string,
): boolean {
  if (previousGeneration === nextGeneration) {
    return true;
  }
  // Stable fingerprints include literal undefined values. Only their scope array is JSON;
  // every surrounding byte must still match the current authority owner's fingerprint.
  const grantPattern = /^(.*"grant":)(\[[^\]]*\])(,.*)$/u;
  const previous = grantPattern.exec(previousGeneration);
  const next = grantPattern.exec(nextGeneration);
  if (!previous || !next || previous[1] !== next[1] || previous[3] !== next[3]) {
    return false;
  }
  try {
    const previousScopes: unknown = JSON.parse(previous[2]!);
    const nextScopes: unknown = JSON.parse(next[2]!);
    if (
      !Array.isArray(previousScopes) ||
      !previousScopes.every(isOperatorScope) ||
      !Array.isArray(nextScopes) ||
      !nextScopes.every(isOperatorScope)
    ) {
      return false;
    }
    return (
      roleScopesAllow({
        role: "operator",
        requestedScopes: previousScopes,
        allowedScopes: nextScopes,
      }) &&
      roleScopesAllow({
        role: "operator",
        requestedScopes: nextScopes,
        allowedScopes: previousScopes,
      })
    );
  } catch {
    return false;
  }
}

export function isGatewayAuthPolicyCurrent(
  policy: GatewayAuthPolicy | undefined,
  config?: OpenClawConfig | null,
): boolean {
  if (!policy) {
    return true;
  }
  const current = config === undefined ? getRuntimeConfig() : config;
  if (current === null) {
    return false;
  }
  const next = captureGatewayAuthPolicy(current, policy);
  return (
    next.generation === policy.generation &&
    areGatewayAuthGrantsEquivalent(policy.grantGeneration, next.grantGeneration)
  );
}

/** Accepted work follows committed access grants, not a transport's need to reauthenticate. */
export function isGatewayAuthGrantCurrent(
  policy: GatewayAuthPolicy | undefined,
  config?: OpenClawConfig | null,
): boolean {
  if (!policy) {
    return true;
  }
  const current = config === undefined ? getRuntimeConfig() : config;
  return (
    current !== null &&
    areGatewayAuthGrantsEquivalent(
      policy.grantGeneration,
      captureGatewayAuthPolicy(current, policy).grantGeneration,
    )
  );
}
