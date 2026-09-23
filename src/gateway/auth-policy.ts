import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const generations = new WeakMap<OpenClawConfig, string>();

/** Session authority follows immutable runtime snapshots, independently of durable device tokens. */
export function resolveGatewayAuthPolicyGeneration(config: OpenClawConfig): string {
  let generation = generations.get(config);
  if (generation === undefined) {
    const gateway = config.gateway;
    const trustedProxy = gateway?.auth?.trustedProxy;
    generation = stableStringify({
      roles: gateway?.roles,
      trustedProxies: gateway?.trustedProxies?.toSorted(),
      allowRealIpFallback: gateway?.allowRealIpFallback,
      allowTailscale: gateway?.auth?.allowTailscale,
      identityScopes: gateway?.auth?.identityScopes,
      trustedProxy: trustedProxy && {
        ...trustedProxy,
        requiredHeaders: (trustedProxy.requiredHeaders ?? []).toSorted(),
        allowUsers: (trustedProxy.allowUsers ?? []).toSorted(),
      },
    });
    generations.set(config, generation);
  }
  return generation;
}

export function isGatewayAuthPolicyCurrent(
  generation: string | undefined,
  config?: OpenClawConfig | null,
): boolean {
  if (generation === undefined) {
    return true;
  }
  const current = config === undefined ? getRuntimeConfig() : config;
  return current !== null && resolveGatewayAuthPolicyGeneration(current) === generation;
}
