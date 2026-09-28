import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveIdentityOperatorScopes } from "./operator-identity-scopes.js";
import { sourceRolePolicies } from "./operator-role-source-policy.js";

const generations = new WeakMap<OpenClawConfig, Map<string | undefined, string>>();

/** Session authority follows immutable runtime snapshots, independently of durable device tokens. */
export function resolveGatewayAuthPolicyGeneration(
  config: OpenClawConfig,
  verifiedIdentity?: string,
): string {
  let identities = generations.get(config);
  if (!identities) {
    identities = new Map();
    generations.set(config, identities);
  }
  let generation = identities.get(verifiedIdentity);
  if (generation === undefined) {
    const gateway = config.gateway;
    const trustedProxy = gateway?.auth?.trustedProxy;
    generation = stableStringify({
      roles: sourceRolePolicies(gateway?.roles),
      trustedProxies: gateway?.trustedProxies?.toSorted(),
      allowRealIpFallback: gateway?.allowRealIpFallback,
      allowTailscale: gateway?.auth?.allowTailscale,
      // A verified connection depends on its own grant, not every other login.
      // Callers without an attested identity retain the conservative whole-policy fence.
      identityScopes:
        verifiedIdentity === undefined
          ? gateway?.auth?.identityScopes
          : [
              ...new Set(
                resolveIdentityOperatorScopes(verifiedIdentity, gateway?.auth?.identityScopes),
              ),
            ].toSorted(),
      trustedProxy: trustedProxy && {
        ...trustedProxy,
        requiredHeaders: (trustedProxy.requiredHeaders ?? []).toSorted(),
        allowUsers: (trustedProxy.allowUsers ?? []).toSorted(),
      },
    });
    identities.set(verifiedIdentity, generation);
  }
  return generation;
}

export function isGatewayAuthPolicyCurrent(
  generation: string | undefined,
  config?: OpenClawConfig | null,
  verifiedIdentity?: string,
): boolean {
  if (generation === undefined) {
    return true;
  }
  const current = config === undefined ? getRuntimeConfig() : config;
  return (
    current !== null && resolveGatewayAuthPolicyGeneration(current, verifiedIdentity) === generation
  );
}
