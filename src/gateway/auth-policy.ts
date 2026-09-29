import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayAuthPolicy } from "./auth-policy.types.js";
import { resolveIdentityOperatorScopes } from "./operator-identity-scopes.js";
import { sourceRolePolicies } from "./operator-role-source-policy.js";

const policies = new WeakMap<
  OpenClawConfig,
  { global: string; identities: Map<string | undefined, GatewayAuthPolicy> }
>();

/** Capture the grant principal together with its generation; null means no identity-derived scopes. */
export function captureGatewayAuthPolicy(
  config: OpenClawConfig,
  principal: { role: string; verifiedIdentity?: string } | null,
): GatewayAuthPolicy {
  const verifiedIdentity =
    principal?.role === "operator"
      ? normalizeOptionalString(principal.verifiedIdentity)
      : undefined;
  let cached = policies.get(config);
  if (!cached) {
    const gateway = config.gateway;
    const trustedProxy = gateway?.auth?.trustedProxy;
    cached = {
      global: stableStringify({
        roles: sourceRolePolicies(gateway?.roles),
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
    };
    policies.set(config, cached);
  }
  let policy = cached.identities.get(verifiedIdentity);
  if (!policy) {
    const grant = verifiedIdentity
      ? [
          ...new Set(
            resolveIdentityOperatorScopes(verifiedIdentity, config.gateway?.auth?.identityScopes),
          ),
        ].toSorted()
      : undefined;
    policy = Object.freeze({
      generation: grant ? `${cached.global}\0${stableStringify(grant)}` : cached.global,
      verifiedIdentity,
    });
    cached.identities.set(verifiedIdentity, policy);
  }
  return policy;
}

export function isGatewayAuthPolicyCurrent(
  policy: GatewayAuthPolicy | undefined,
  config?: OpenClawConfig | null,
): boolean {
  if (!policy) {
    return true;
  }
  const current = config === undefined ? getRuntimeConfig() : config;
  return (
    current !== null &&
    captureGatewayAuthPolicy(current, {
      role: "operator",
      verifiedIdentity: policy.verifiedIdentity,
    }).generation === policy.generation
  );
}
